// scripts/novus-lifecycle-selftest.mjs — hermetic test (no network, no
// creds) for the probe lifecycle/finalisation behaviour added on top of the
// existing V2 pipeline (lib/observation-recompute.mjs, lib/intelligence-
// rebuild.mjs, lib/diagnosis-rebuild.mjs, lib/rebuild-pass.mjs):
//
//   PROBE SENT -> communications arrive -> INTELLIGENCE updates in real time
//   -> 4 days after the probe was sent, the probe closes -> final
//   INTELLIGENCE is calculated from everything received during those 4 days
//   -> final DIAGNOSIS is generated once -> DIAGNOSIS is frozen.
//
// This suite does NOT touch the Intelligence/Diagnosis methodology itself —
// that's covered by lib/probe-interpretation.mjs's and lib/probe-diagnosis.mjs's
// own selftests. It proves the LIFECYCLE wrapper around them:
//   1. Intelligence updates while a probe is open, using the FULL
//      communication history so far on every new communication.
//   2. Diagnosis does NOT run while a probe is still open.
//   3. A probe with an elapsed 4-day window closes automatically the next
//      time lib/rebuild-pass.mjs's runRebuildPass() runs — the same function
//      the Vercel Cron entry point (api/novus/intelligence/finalize.js) and
//      the human "Rebuild Intelligence" button both call — with NO new
//      communication required to trigger it.
//   4. Closing a probe produces its final INTELLIGENCE and, in the same
//      pass, its final DIAGNOSIS.
//   5. A probe that received ZERO communications during its window still
//      gets a final Diagnosis, explicitly reflecting zero agency contact.
//   6. A communication arriving after a probe is finalised is stored in
//      COMMUNICATIONS as raw evidence, but never changes that probe's
//      (frozen) INTELLIGENCE or DIAGNOSIS — whether reached via the
//      single-probe path (lib/observation-recompute.mjs) or a subsequent
//      rebuild pass, and also never matches through the normal deterministic
//      front door (lib/matching.mjs) once the window has closed.
//   7. A normal (non-forced) rebuild pass leaves every finalised probe's
//      Diagnosis untouched — zero AI calls, byte-identical rows.
//   8. A forced rebuild pass (force_ai) only ever touches probes that
//      haven't been finalised yet; finalised probes stay frozen regardless.
//   9. The AI-call batching added for the 504-timeout fix
//      (scripts/novus-rebuild-batching-selftest.mjs) still holds with the
//      finalised-probe freeze layered on top — a finalised probe costs
//      nothing from the AI-call budget, so budget goes entirely to probes
//      that still have real work.
//  10. A historical probe with a BLANK PROBES.observation_deadline gets it
//      derived (probe_timestamp + 4 days) and persisted back onto PROBES —
//      and if that derived deadline has already passed, the probe closes
//      and gets its final Diagnosis in that same pass. A probe still within
//      its derived window is backfilled but stays open. A probe that
//      already HAS an observation_deadline is never touched, even if it's
//      a different value than probe_timestamp + 4 days would give. All of
//      it is idempotent — a second pass changes nothing further.
//
// Run: npm run novus:lifecycle-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { recomputeProbeObservation } from '../lib/observation-recompute.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { matchProbe } from '../lib/matching.mjs';
import { DEMOS_HEADER, DEMO_VERSION } from '../lib/demos.mjs';
import { OUTBOUND_HEADER } from '../lib/outbound.mjs';
import finalizeHandler from '../api/novus/intelligence/finalize.js';
import rebuildAllHandler from '../api/novus/intelligence/rebuild-all.js';

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
  'findings',
  'strengths', 'missed_opportunities', 'commercial_implication', 'novus_opportunity',
  'diagnosis_summary', 'created_at', 'updated_at',
];
const PERSONALISATION_HEADER = [
  'personalisation_id', 'agency_id', 'probe_id', 'hero_journey', 'primary_narrative',
  'narrative_finding_indexes', 'positive_finding_index', 'main_finding_index',
  'wider_finding_index', 'supporting_findings', 'evidence', 'novus_counterfactual',
  'fair_observation', 'main_finding', 'commercial_consequence',
  'property_reference', 'email_observation', 'email_commercial_hook',
  'email_commercial_hook_email_2',
  'created_at', 'updated_at',
];
const DIAGNOSIS_FINDINGS_HEADER = ['probe_id', 'finding_index', 'finding', 'evidence', 'significance_note'];

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    PERSONALISATION: [PERSONALISATION_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    AGENCIES: [['agency_id'], ['SCHEMA NOTE', 'Fixture']],
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
function findRow(store, tab, header, probeId) {
  const r = store[tab].slice(2).find((r) => r[header.indexOf('probe_id')] === probeId);
  return r ? toObj(header, r) : undefined;
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// Blocks until Date.now() is past the millisecond `timestamp` was taken in, so
// a freshly-written updated_at is guaranteed to differ from it.
async function waitForNewMillisecond(timestamp) {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return;
  while (Date.now() <= t) await new Promise((r) => setTimeout(r, 1));
}

// Far enough in the past that resolveObservationDeadline()'s 4-day window
// has always closed, regardless of when this test runs.
const OLD_TIMESTAMP = '2020-01-01T09:00:00.000Z';

// A single shared AI stub covering both interpretProbe() and diagnoseProbe()
// calls across this whole file. Distinguished by the tool name each module
// registers (see lib/probe-interpretation.mjs / lib/probe-diagnosis.mjs).
let interpretCallCount = 0;
let diagnoseCallCount = 0;
let personaliseCallCount = 0;
function installAiStub() {
  interpretCallCount = 0;
  diagnoseCallCount = 0;
  personaliseCallCount = 0;
  __setAiCallerForTests(async ({ tool, prompt }) => {
    if (tool?.name === 'record_probe_personalisation') {
      personaliseCallCount += 1;
      return {
        story_reasoning: 'Finding 1 is the selected story.',
        primary_narrative: 'stub narrative',
        positive_finding_index: null, main_finding_index: 1, wider_finding_index: null,
        supporting_findings: '',
        fair_observation: '',
        novus_counterfactual: 'stub counterfactual',
        main_finding: 'stub main finding.',
        commercial_consequence: 'stub consequence.',
        email_observation: 'Nobody came back to the enquiry with a viewing or a next step of any kind.',
        // WHY it matters, not the observation again — and never an outcome
        // that needed a reply this probe deliberately never sends.
        email_commercial_hook: 'So a buyer already in front of you stayed a name in the inbox rather than someone you knew anything about.',
        email_commercial_hook_email_2: 'The part worth a second look is that the enquiry told you more about me than anything you did with it.',
      };
    }
    // The bounded, field-scoped correction call.
    if (tool?.name === 'correct_probe_personalisation_fields') {
      personaliseCallCount += 1;
      return Object.fromEntries(tool.input_schema.required
        .map((field) => [field, 'So a buyer already in front of you stayed a name in the inbox rather than someone you knew anything about.']));
    }
    if (tool?.name === 'record_probe_diagnosis') {
      diagnoseCallCount += 1;
      const zeroContact = /Human contact: none/.test(prompt);
      return zeroContact
        ? {
            findings: [{
              finding: 'No agency contact was recorded at any point during the 4-day observation window.',
              evidence: 'Human contact: none; response_hours blank; contact_attempts 0.',
              significance_note: 'Total silence the agency has no internal visibility into.',
            }],
            // Required by the tool schema, and the AI client now validates a
            // fake exactly as it validates the wire.
            positive_findings: [],
            strengths: '', missed_opportunities: 'Both the viewing and the declared property to sell went entirely unanswered.',
            commercial_implication: 'This agency never engaged with this specific enquiry at all.',
            novus_opportunity: 'Core (front desk)',
            diagnosis_summary: 'Zero agency contact throughout the entire 4-day observation window — the enquiry was never answered on any channel.',
          }
        : {
            findings: [],
            positive_findings: [],
            strengths: 'Responded and engaged across the communications received.',
            missed_opportunities: '', commercial_implication: 'Handled promptly for this specific enquiry.',
            novus_opportunity: 'None evidenced',
            diagnosis_summary: 'Handled the probe well within the observation window.',
          };
    }
    interpretCallCount += 1;
    return {
      viewing_progression: 'invited',
      buyer_qualification: 'minimal',
      buyer_questions_asked: [{ topic: 'availability', quote: 'when suits?', communication_id: 'com_stub' }],
      seller_recognition: 'none',
      communication_quality: 'competent',
      did_well: 'Responded and offered a viewing.',
      missed: '',
      evidence: [{ quote: 'when suits?', communication_id: 'com_stub' }],
    };
  });
}

async function run() {
  console.log('Probe lifecycle / finalisation — hermetic selftest\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);
  installAiStub();

  // ── 1 + 2: Intelligence updates while OPEN; Diagnosis withheld ──────────
  const probeSentAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // sent 2h ago
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_open', probe_reference: 'RM-OPEN', agency_id: 'agc_a',
    property_address: '1 Open Street', property_price: '£300,000',
    enquiry_text: 'Interested in viewing this property.',
    probe_timestamp: probeSentAt.toISOString(),
    observation_deadline: new Date(probeSentAt.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
    probe_status: 'observing',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_open_1', agency_id: 'agc_a', probe_id: 'prb_open',
    occurred_at: new Date(probeSentAt.getTime() + 30 * 60 * 1000).toISOString(), // +30min
    channel: 'voice', body_text: 'Left a voicemail about the viewing.', match_status: 'matched',
  }));

  const r1 = await recomputeProbeObservation(repo, 'prb_open');
  assert.strictEqual(r1.observation_status, 'observing', 'probe stays open — window has not elapsed');
  assert.strictEqual(r1.diagnosis_id, null, 'no Diagnosis for an open probe');
  assert.strictEqual(r1.finalized, false);
  assert.strictEqual(diagnoseCallCount, 0, 'no AI diagnosis call while open');
  assert.strictEqual(interpretCallCount, 1);
  let intel = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_open');
  assert.strictEqual(intel.contact_attempts, 1);
  assert.strictEqual(intel.follow_ups, 0);
  assert.strictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_open'), undefined, 'no DIAGNOSIS row at all while open');
  ok('Intelligence is written for an open probe; no Diagnosis is generated (requirements 1 start + 2)');

  // A second communication, well over 30 minutes after the first (new contact
  // attempt) — the recompute must use the FULL history (both messages), not
  // just the newly-arrived one.
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_open_2', agency_id: 'agc_a', probe_id: 'prb_open',
    occurred_at: new Date(probeSentAt.getTime() + 90 * 60 * 1000).toISOString(), // +90min, +60min after attempt 1
    channel: 'email', body_text: 'Following up on the voicemail with viewing details.', match_status: 'matched',
  }));
  const r2 = await recomputeProbeObservation(repo, 'prb_open');
  assert.strictEqual(r2.observation_status, 'observing');
  assert.strictEqual(r2.diagnosis_id, null, 'still open — still no Diagnosis');
  assert.strictEqual(diagnoseCallCount, 0);
  intel = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_open');
  assert.strictEqual(intel.contact_attempts, 2, 'the recompute used the FULL communication history (both messages), not just the new one');
  assert.strictEqual(intel.follow_ups, 1);
  assert.strictEqual(intel.channels_used, 'voice,email');
  ok('a new communication recomputes Intelligence from the full history so far, and Diagnosis keeps being withheld (requirements 1 + 2)');

  // ── 3 + 4: Automatic closure + final Intelligence/Diagnosis on close ────
  // Two communications arrived during the window, but — modelling the exact
  // gap the Cron closes — nothing ever recomputed this probe afterwards.
  // Nothing in this suite calls recomputeProbeObservation for it; only the
  // scheduled/batch pass (runRebuildPass, what api/novus/intelligence/
  // finalize.js's Cron calls) does.
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_expire', probe_reference: 'RM-EXPIRE', agency_id: 'agc_b',
    property_address: '2 Expire Street', property_price: '£250,000',
    enquiry_text: 'Interested in viewing this property.',
    probe_timestamp: OLD_TIMESTAMP,
    observation_deadline: new Date(new Date(OLD_TIMESTAMP).getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
    probe_status: 'observing',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_expire_1', agency_id: 'agc_b', probe_id: 'prb_expire',
    occurred_at: new Date(new Date(OLD_TIMESTAMP).getTime() + 30 * 60 * 1000).toISOString(),
    channel: 'email', body_text: 'Happy to show you round.', match_status: 'matched',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_expire_2', agency_id: 'agc_b', probe_id: 'prb_expire',
    occurred_at: new Date(new Date(OLD_TIMESTAMP).getTime() + 90 * 60 * 1000).toISOString(),
    channel: 'email', body_text: 'Following up with more viewing details.', match_status: 'matched',
  }));

  assert.strictEqual(findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_expire'), undefined, 'sanity: nothing has recomputed this probe yet');
  const passResult = await runRebuildPass(repo, {});
  const expireIntel = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_expire');
  assert.strictEqual(expireIntel.observation_status, 'closed', 'the elapsed window closes the probe automatically, with no new communication needed');
  assert.strictEqual(expireIntel.contact_attempts, 2, 'final Intelligence reflects everything received during the 4-day window');
  const expireProbe = findRow(store, 'PROBES', PROBES_HEADER, 'prb_expire');
  assert.strictEqual(expireProbe.probe_status, 'closed', 'the existing PROBES.probe_status lifecycle field is flipped to closed too');
  ok('a probe past its 4-day deadline is closed automatically by the scheduled/rebuild pass alone (requirement 3)');

  const expireDiag = findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_expire');
  assert.ok(expireDiag && expireDiag.diagnosis_summary, 'closing the probe produced a final Diagnosis in the same pass');
  assert.strictEqual(passResult.diagnosis.ai_diagnoses_run, 1);
  ok('closing a probe triggers its final Intelligence AND its final Diagnosis, generated exactly once (requirement 4)');

  // ── 5: Zero-communication probe still gets a final Diagnosis ────────────
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_silent', probe_reference: 'RM-SILENT', agency_id: 'agc_c',
    property_address: '3 Silent Street', property_price: '£275,000',
    enquiry_text: 'Interested in viewing this property.',
    probe_timestamp: OLD_TIMESTAMP,
    observation_deadline: new Date(new Date(OLD_TIMESTAMP).getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
    probe_status: 'observing',
  }));
  // Deliberately zero COMMUNICATIONS rows for prb_silent.

  await runRebuildPass(repo, {});
  const silentIntel = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_silent');
  assert.strictEqual(silentIntel.observation_status, 'closed');
  assert.strictEqual(silentIntel.human_contact, 'none');
  assert.strictEqual(silentIntel.grade, 'H', 'zero evidence + elapsed window grades H, the unchanged A-H engine');
  const silentDiag = findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_silent');
  assert.ok(silentDiag && silentDiag.diagnosis_summary, 'a zero-communication probe still gets a final Diagnosis');
  assert.match(silentDiag.diagnosis_summary, /zero agency contact/i, 'the Diagnosis explicitly reflects zero agency contact, not a blank/skipped row');
  ok('a probe with zero communications during its window still receives a final Diagnosis explicitly reflecting zero agency contact (requirement 5)');

  // ── 6: Late communications stored but never change a closed probe ───────
  const expireIntelSnapshot = { ...expireIntel };
  const expireDiagSnapshot = { ...expireDiag };
  const aiCallsBefore = { interpret: interpretCallCount, diagnose: diagnoseCallCount };

  // A message physically arrives and is stored as raw evidence — this is
  // what "still stored normally in COMMUNICATIONS" means; it happens
  // independently of whatever lib/matching.mjs decides to do with it.
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_expire_late', agency_id: 'agc_b', probe_id: 'prb_expire',
    occurred_at: new Date().toISOString(), channel: 'email',
    body_text: 'A very late reply, long after the window closed.', match_status: 'matched',
  }));
  assert.ok(store.COMMUNICATIONS.slice(2).some((r) => r[0] === 'com_expire_late'), 'the late communication is physically stored in COMMUNICATIONS');

  // Reached via the single-probe path (e.g. a mistaken manual call) — frozen,
  // no AI call, no change.
  const lateResult = await recomputeProbeObservation(repo, 'prb_expire');
  assert.strictEqual(lateResult.frozen, true);
  assert.strictEqual(lateResult.finalized, true);

  // Reached via a subsequent rebuild pass (e.g. the next Cron tick, or the
  // human clicking Rebuild again) — also frozen.
  await runRebuildPass(repo, {});

  assert.strictEqual(interpretCallCount, aiCallsBefore.interpret, 'the late communication triggers zero further AI interpretation');
  assert.strictEqual(diagnoseCallCount, aiCallsBefore.diagnose, 'the late communication triggers zero further AI diagnosis');
  assert.deepStrictEqual(findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_expire'), expireIntelSnapshot, 'INTELLIGENCE is byte-identical — the late communication never changed it');
  assert.deepStrictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_expire'), expireDiagSnapshot, 'DIAGNOSIS is byte-identical — the late communication never changed it');

  // And the natural front door (deterministic matching) already refuses to
  // attach a new message to a probe whose window has closed, independent of
  // the freeze above.
  const lateMatch = await matchProbe(repo, 'agc_b', new Date());
  assert.strictEqual(lateMatch.status, 'none', 'lib/matching.mjs never matches a new communication to a probe once its observation window has elapsed');
  ok('a communication arriving after finalisation is stored as raw evidence but never changes the closed probe\'s Intelligence or Diagnosis, via either code path or the matching front door (requirement 6)');

  // ── 7: Normal rebuilds leave finalised diagnoses untouched ───────────────
  const beforeNormal = { interpret: interpretCallCount, diagnose: diagnoseCallCount };
  const normalRebuild = await runRebuildPass(repo, {});
  assert.strictEqual(interpretCallCount, beforeNormal.interpret, 'a normal rebuild spends zero further AI calls on finalised probes');
  assert.strictEqual(diagnoseCallCount, beforeNormal.diagnose);
  assert.ok(normalRebuild.probes_finalized_skipped >= 2, 'prb_expire and prb_silent are both reported as finalised/skipped (prb_open is still open, not finalised)');
  assert.deepStrictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_expire'), expireDiagSnapshot);
  assert.deepStrictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_silent'), silentDiag);
  ok('a normal (non-forced) rebuild pass leaves every already-finalised Diagnosis untouched (requirement 7)');

  // ── 8: Forced rebuilds only touch probes that aren't finalised yet ──────
  // prb_open is still open (not finalised) — force_ai must still be able to
  // re-interpret it.
  const openBeforeForce = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_open');
  // prb_undiagnosed: closed, but its Diagnosis never actually succeeded
  // (row present with a blank diagnosis_summary) — NOT finalised, must still
  // be picked up by a normal OR forced rebuild.
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_undiagnosed', probe_reference: 'RM-UNDIAG', agency_id: 'agc_d',
    property_address: '4 Undiagnosed Street', property_price: '£260,000',
    enquiry_text: 'Interested.', probe_timestamp: OLD_TIMESTAMP,
    observation_deadline: new Date(new Date(OLD_TIMESTAMP).getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
    probe_status: 'closed',
  }));
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_undiag', agency_id: 'agc_d', probe_id: 'prb_undiagnosed',
    observation_status: 'closed', communication_quality: 'generic', grade: 'H',
    created_at: OLD_TIMESTAMP,
  }));
  store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
    diagnosis_id: 'dgn_undiag', agency_id: 'agc_d', probe_id: 'prb_undiagnosed',
    diagnosis_summary: '', // a prior AI attempt errored before writing content
    created_at: OLD_TIMESTAMP,
  }));

  const beforeForce = { interpret: interpretCallCount, diagnose: diagnoseCallCount };
  // updated_at has millisecond resolution, and two rebuild passes in the same
  // process can land inside the same millisecond — which made the "prb_open
  // was actually re-touched" assertion below fail intermittently even though
  // the row HAD been rewritten. Wait for the clock to leave that millisecond
  // so the comparison measures a rewrite rather than the scheduler.
  await waitForNewMillisecond(openBeforeForce.updated_at);
  const forced = await runRebuildPass(repo, { forceAi: true });

  assert.strictEqual(forced.diagnosis.ai_diagnoses_run, 1, 'the not-yet-finalised prb_undiagnosed gets diagnosed');
  const undiagResult = findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_undiagnosed');
  assert.ok(undiagResult.diagnosis_summary, 'prb_undiagnosed now has a real Diagnosis');

  assert.ok(interpretCallCount > beforeForce.interpret, 'force_ai still re-interprets the still-open, not-yet-finalised prb_open');
  const openAfterForce = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_open');
  assert.notDeepStrictEqual(openAfterForce.updated_at, openBeforeForce.updated_at, 'prb_open was actually re-touched by the forced rebuild');

  // The already-finalised probes from earlier must still be completely
  // untouched by the SAME forced call.
  assert.deepStrictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_expire'), expireDiagSnapshot, 'force_ai never resurrects an already-finalised Diagnosis (prb_expire)');
  assert.deepStrictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_silent'), silentDiag, 'force_ai never resurrects an already-finalised Diagnosis (prb_silent)');
  ok('a forced rebuild only affects probes that have not been finalised yet — finalised probes stay frozen even under force_ai (requirement 8)');

  // ── 9: Batching still works with the finalised-probe freeze in place ────
  // A tiny AI-call budget, spent entirely by prb_open (still needs AI): the
  // three already-finalised probes (prb_expire, prb_silent, prb_undiagnosed)
  // must not consume any of that budget — freeze is checked BEFORE the
  // budget check, so it's free, not merely "first in line".
  installAiStub(); // reset counters
  const budgeted = await rebuildAllIntelligence(repo, { forceAi: true, maxAiCalls: 1 });
  assert.strictEqual(budgeted.ai_interpretations_run, 1, 'the one AI call in budget goes to prb_open, the only non-finalised probe left needing one');
  assert.strictEqual(budgeted.remaining_interpretations, 0, 'no finalised probe counts as "remaining" work — they are frozen, not queued');
  assert.ok(budgeted.probes_finalized_skipped >= 3, 'finalised probes are reported as skipped, not as spending budget');
  ok('AI-call batching (the 504-timeout fix) still holds with the finalised-probe freeze layered on top — frozen probes cost nothing from the budget (requirement 9; full batching regression: npm run novus:rebuild-batching-selftest)');

  // ── 10: Blank observation_deadline backfill for historical probes ───────
  // Historical probe A: past deadline once derived (probe_timestamp+4days),
  // has communications, blank observation_deadline on PROBES — models a
  // real pre-lifecycle-feature import.
  const histSentAt = new Date(OLD_TIMESTAMP);
  const histDerivedDeadline = new Date(histSentAt.getTime() + 4 * 24 * 60 * 60 * 1000);
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_hist_expired', probe_reference: 'RM-HIST-EXP', agency_id: 'agc_e',
    property_address: '5 Historical Street', property_price: '£310,000',
    enquiry_text: 'Interested in viewing this property.',
    probe_timestamp: histSentAt.toISOString(),
    observation_deadline: '', // blank — never written when this probe was imported
    probe_status: 'observing',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_hist_1', agency_id: 'agc_e', probe_id: 'prb_hist_expired',
    occurred_at: new Date(histSentAt.getTime() + 45 * 60 * 1000).toISOString(),
    channel: 'email', body_text: 'Happy to arrange a viewing.', match_status: 'matched',
  }));

  // Historical probe B: same blank observation_deadline, but sent recently
  // enough that its derived deadline hasn't passed yet — must be backfilled
  // but must stay open (no Diagnosis).
  const histRecentSentAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_hist_future', probe_reference: 'RM-HIST-FUT', agency_id: 'agc_f',
    property_address: '6 Historical Avenue', property_price: '£320,000',
    enquiry_text: 'Interested.', probe_timestamp: histRecentSentAt.toISOString(),
    observation_deadline: '', probe_status: 'observing',
  }));

  // Control probe: an EXPLICIT observation_deadline that is deliberately
  // NOT probe_timestamp + 4 days (and already past) — must survive
  // byte-for-byte, proving the backfill only ever touches a truly blank cell.
  const explicitDeadline = new Date(histSentAt.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(); // +10 days, not +4
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: 'prb_explicit_deadline', probe_reference: 'RM-EXPLICIT', agency_id: 'agc_g',
    property_address: '7 Explicit Road', property_price: '£330,000',
    enquiry_text: 'Interested.', probe_timestamp: histSentAt.toISOString(),
    observation_deadline: explicitDeadline, probe_status: 'observing',
  }));

  await runRebuildPass(repo, {});

  const histExpiredProbe = findRow(store, 'PROBES', PROBES_HEADER, 'prb_hist_expired');
  assert.strictEqual(histExpiredProbe.observation_deadline, histDerivedDeadline.toISOString(), 'the blank deadline is derived as probe_timestamp + 4 days and persisted onto PROBES');
  assert.strictEqual(histExpiredProbe.probe_status, 'closed', 'the derived deadline had already passed, so the probe closes in the same pass');
  const histExpiredIntel = findRow(store, 'INTELLIGENCE', INTELLIGENCE_HEADER, 'prb_hist_expired');
  assert.strictEqual(histExpiredIntel.observation_status, 'closed');
  const histExpiredDiag = findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_hist_expired');
  assert.ok(histExpiredDiag && histExpiredDiag.diagnosis_summary, 'the final Diagnosis is generated and frozen in the very same pass that backfilled the deadline');
  ok('a historical probe with a blank observation_deadline whose derived deadline has already passed is backfilled, closed, and diagnosed in one pass (requirement 10a)');

  const histFutureProbe = findRow(store, 'PROBES', PROBES_HEADER, 'prb_hist_future');
  const histFutureDerivedDeadline = new Date(histRecentSentAt.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(histFutureProbe.observation_deadline, histFutureDerivedDeadline, 'the blank deadline is backfilled even for a probe still within its window');
  assert.strictEqual(histFutureProbe.probe_status, 'observing', 'the derived deadline has not passed yet, so the probe stays open');
  assert.strictEqual(findRow(store, 'DIAGNOSIS', DIAGNOSIS_HEADER, 'prb_hist_future'), undefined, 'no Diagnosis for a backfilled-but-still-open probe');
  ok('a historical probe with a blank observation_deadline still within its derived window is backfilled but stays open, with no Diagnosis (requirement 10b)');

  const explicitProbe = findRow(store, 'PROBES', PROBES_HEADER, 'prb_explicit_deadline');
  assert.strictEqual(explicitProbe.observation_deadline, explicitDeadline, 'a probe that already has an observation_deadline is never altered, even though it differs from probe_timestamp + 4 days');
  ok('a probe with an existing observation_deadline is left completely untouched by the backfill (requirement 10c)');

  // Idempotency: a second pass changes nothing further for any of the three.
  const aiCountsBeforeSecond = { interpret: interpretCallCount, diagnose: diagnoseCallCount };
  const secondBackfillPass = await runRebuildPass(repo, {});
  assert.strictEqual(interpretCallCount, aiCountsBeforeSecond.interpret, 'a second pass makes no further AI interpretation calls for these probes');
  assert.strictEqual(diagnoseCallCount, aiCountsBeforeSecond.diagnose, 'a second pass makes no further AI diagnosis calls — prb_hist_expired is now finalised, prb_hist_future is still open');
  assert.deepStrictEqual(findRow(store, 'PROBES', PROBES_HEADER, 'prb_hist_expired'), histExpiredProbe, 'prb_hist_expired PROBES row is byte-identical after a second pass');
  assert.deepStrictEqual(findRow(store, 'PROBES', PROBES_HEADER, 'prb_hist_future'), histFutureProbe, 'prb_hist_future PROBES row is byte-identical after a second pass (already backfilled, still open)');
  assert.deepStrictEqual(findRow(store, 'PROBES', PROBES_HEADER, 'prb_explicit_deadline'), explicitProbe, 'prb_explicit_deadline PROBES row is byte-identical after a second pass');
  ok('the backfill is fully idempotent — a second rebuild pass changes nothing further for any of these probes (requirement 10d)');

  // ── 11: the nightly OUTBOUND compile follows the DEMOS stage ────────────
  // Seed the already-compiled, campaign-ready downstream state that the
  // deterministic OUTBOUND compiler consumes. The opted-in pass must execute
  // its normal DEMOS stage first, then write READY, while leaving later SENT
  // and SUPPRESSED execution state untouched.
  store.DEMOS = [DEMOS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']];
  store.OUTBOUND = [OUTBOUND_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']];
  store.AGENCIES = [[
    'agency_id', 'agency_name', 'clean_agency_name', 'outreach_contact_name',
    'outreach_contact_email', 'email_verification_status',
  ], ['SCHEMA NOTE', 'Fixture'], [
    'agc_b', 'Expire Estates', 'Expire Estates', 'Bradley Stanton',
    'bradley@example.com', 'VALID',
  ]];
  const expireProbeIndex = store.PROBES.findIndex((r, index) => index > 1 && r[PROBES_HEADER.indexOf('probe_id')] === 'prb_expire');
  store.PROBES[0].push('property_street');
  store.PROBES[expireProbeIndex].push('2 Expire Street');
  store.DEMOS.push(row(DEMOS_HEADER, {
    agency_id: 'agc_b', probe_id: 'prb_expire', demo_slug: 'expire-estates-rm-expire',
    demo_status: 'ready', property_image_status: 'ok', demo_version: String(DEMO_VERSION),
    enquiry_date: '1 January', enquiry_time: '09:00',
  }));
  const expirePersonalisation = {
    personalisation_id: 'per_expire', agency_id: 'agc_b', probe_id: 'prb_expire',
    primary_narrative: 'stub narrative',
    email_observation: 'No follow-up was recorded after the enquiry.',
    email_commercial_hook: 'The enquiry did not become a conversation.',
    email_commercial_hook_email_2: 'The opportunity remained untouched.',
  };
  const personalisationProbeColumn = PERSONALISATION_HEADER.indexOf('probe_id');
  const expirePersonalisationIndex = store.PERSONALISATION
    .findIndex((r, index) => index > 1 && r[personalisationProbeColumn] === 'prb_expire');
  if (expirePersonalisationIndex > 1) {
    store.PERSONALISATION[expirePersonalisationIndex] = row(PERSONALISATION_HEADER, expirePersonalisation);
  } else {
    store.PERSONALISATION.push(row(PERSONALISATION_HEADER, expirePersonalisation));
  }

  const nightly = await runRebuildPass(repo, { rebuildOutbound: true });
  assert.ok(nightly.demos, 'the nightly pass completed its DEMOS stage');
  assert.equal(nightly.outbound.create_count, 1, 'the nightly pass writes the newly eligible row');
  const outboundRow = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_expire');
  assert.equal(outboundRow.outbound_status, 'READY');
  outboundRow.outbound_status = 'SENT';
  outboundRow.instantly_lead_id = 'lead_123';
  outboundRow.instantly_added_at = '2026-08-28T12:00:00.000Z';
  outboundRow.last_error = 'historic error';
  const outboundIndex = store.OUTBOUND.findIndex((r, index) => index > 1 && r[OUTBOUND_HEADER.indexOf('probe_id')] === 'prb_expire');
  store.OUTBOUND[outboundIndex] = row(OUTBOUND_HEADER, outboundRow);
  await runRebuildPass(repo, { rebuildOutbound: true });
  const preservedSent = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_expire');
  assert.equal(preservedSent.outbound_status, 'SENT');
  assert.equal(preservedSent.instantly_lead_id, 'lead_123');
  assert.equal(preservedSent.instantly_added_at, '2026-08-28T12:00:00.000Z');
  assert.equal(preservedSent.last_error, 'historic error');
  preservedSent.outbound_status = 'SUPPRESSED';
  store.OUTBOUND[outboundIndex] = row(OUTBOUND_HEADER, preservedSent);
  await runRebuildPass(repo, { rebuildOutbound: true });
  const preservedSuppressed = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_expire');
  assert.equal(preservedSuppressed.outbound_status, 'SUPPRESSED');
  assert.equal(preservedSuppressed.instantly_lead_id, 'lead_123');
  assert.equal(preservedSuppressed.instantly_added_at, '2026-08-28T12:00:00.000Z');
  assert.equal(preservedSuppressed.last_error, 'historic error');
  ok('the nightly path runs after DEMOS, writes eligible OUTBOUND rows, and preserves SENT and SUPPRESSED execution fields');

  console.log(`\n${passed} checks passed.`);
}

async function runNightlyOutboundOnly() {
  console.log('Nightly OUTBOUND finalization path — hermetic selftest\n');

  const { store, repo } = makeFakeSheet();
  __setRepoForTests(repo);

  // Keep this fixture fully downstream: the normal pass sees an already
  // finalised probe, then reaches DEMOS before compiling the ready OUTBOUND
  // row. The fetch stub accepts only the expected final Instantly call.
  store.AGENCIES = [[
    'agency_id', 'agency_name', 'clean_agency_name', 'outreach_contact_name',
    'outreach_contact_email', 'email_verification_status',
  ], ['SCHEMA NOTE', 'Fixture'], [
    'agc_nightly', 'Nightly Estates', 'Nightly Estates', 'Alex Nightly',
    'alex@example.com', 'VALID',
  ]];
  store.PROBES[0].push('property_street');
  const nightlyProbe = row(PROBES_HEADER, {
    probe_id: 'prb_nightly', probe_reference: 'RM-NIGHTLY', agency_id: 'agc_nightly',
    property_address: '3 Cron Street', property_price: '£300,000', probe_status: 'closed',
    probe_timestamp: OLD_TIMESTAMP, observation_deadline: OLD_TIMESTAMP,
  });
  nightlyProbe.push('3 Cron Street');
  store.PROBES.push(nightlyProbe);
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_nightly', agency_id: 'agc_nightly', probe_id: 'prb_nightly',
    observation_status: 'closed', communication_quality: 'competent', grade: 'B',
  }));
  store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
    diagnosis_id: 'dgn_nightly', agency_id: 'agc_nightly', probe_id: 'prb_nightly',
    diagnosis_summary: 'Finalised diagnosis.',
  }));
  store.PERSONALISATION.push(row(PERSONALISATION_HEADER, {
    personalisation_id: 'per_nightly', agency_id: 'agc_nightly', probe_id: 'prb_nightly',
    primary_narrative: 'A ready story.',
    email_observation: 'No follow-up was recorded.',
    email_commercial_hook: 'The enquiry did not become a conversation.',
    email_commercial_hook_email_2: 'The opportunity remained untouched.',
  }));
  store.DEMOS = [DEMOS_HEADER.slice(), ['SCHEMA NOTE', 'Fixture'], row(DEMOS_HEADER, {
    agency_id: 'agc_nightly', probe_id: 'prb_nightly', demo_slug: 'nightly-estates-rm-nightly',
    demo_status: 'ready', demo_version: String(DEMO_VERSION), property_image_status: 'ok',
    enquiry_date: '1 January', enquiry_time: '09:00',
  })];
  store.OUTBOUND = [OUTBOUND_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']];

  const trace = [];
  const getTable = repo.getTable.bind(repo);
  const writeRowsBatch = repo.writeRowsBatch.bind(repo);
  const appendRowsBatch = repo.appendRowsBatch.bind(repo);
  repo.getTable = async (tab) => { trace.push(`read:${tab}`); return getTable(tab); };
  repo.writeRowsBatch = async (...args) => { trace.push('write:OUTBOUND'); return writeRowsBatch(...args); };
  repo.appendRowsBatch = async (...args) => { trace.push('append:OUTBOUND'); return appendRowsBatch(...args); };
  repo.writeCellsBatch = async (writes) => {
    trace.push('write:INSTANTLY_MARKERS');
    for (const write of writes) {
      store[write.tab][write.rowNumber - 1][write.columnNumber - 1] = write.value;
    }
  };

  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'https://api.instantly.ai/api/v2/leads') {
      trace.push('instantly:POST');
      return { ok: true, status: 200, async text() { return JSON.stringify({ id: 'lead_nightly' }); } };
    }
    throw new Error(`Unexpected network call: ${url}`);
  };
  const oldSecret = process.env.CRON_SECRET;
  const oldBatchSize = process.env.NOVUS_REBUILD_BATCH_SIZE;
  const oldInstantlyKey = process.env.INSTANTLY_API_KEY;
  const oldInstantlyCampaign = process.env.INSTANTLY_CAMPAIGN_ID;
  process.env.CRON_SECRET = 'nightly-test-secret';
  process.env.NOVUS_REBUILD_BATCH_SIZE = '1';
  process.env.INSTANTLY_API_KEY = 'nightly-instantly-key';
  process.env.INSTANTLY_CAMPAIGN_ID = 'nightly-campaign';
  let response;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { response = body; return body; },
    setHeader() {},
    end() {},
  };
  try {
    await finalizeHandler({ method: 'GET', headers: { authorization: 'Bearer nightly-test-secret' } }, res);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
    if (oldBatchSize === undefined) delete process.env.NOVUS_REBUILD_BATCH_SIZE; else process.env.NOVUS_REBUILD_BATCH_SIZE = oldBatchSize;
    if (oldInstantlyKey === undefined) delete process.env.INSTANTLY_API_KEY; else process.env.INSTANTLY_API_KEY = oldInstantlyKey;
    if (oldInstantlyCampaign === undefined) delete process.env.INSTANTLY_CAMPAIGN_ID; else process.env.INSTANTLY_CAMPAIGN_ID = oldInstantlyCampaign;
  }

  assert.equal(res.statusCode, 200);
  assert.ok(response.demos, 'finalize completed the DEMOS stage');
  assert.equal(response.outbound.dry_run, false);
  assert.equal(response.outbound.create_count, 1);
  assert.equal(response.instantly.uploaded_rows, 1);
  assert.equal(response.instantly.failed_rows, 0);
  let outbound = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_nightly');
  assert.equal(outbound.outbound_status, 'READY');
  assert.equal(outbound.instantly_lead_id, 'lead_nightly');
  assert.ok(trace.lastIndexOf('read:DEMOS') < trace.indexOf('read:OUTBOUND'), 'OUTBOUND is read only after DEMOS');
  assert.ok(trace.includes('append:OUTBOUND'), 'eligible OUTBOUND row is written');
  assert.ok(trace.lastIndexOf('append:OUTBOUND') < trace.indexOf('instantly:POST'), 'Instantly handoff runs only after OUTBOUND is rebuilt');

  outbound.outbound_status = 'SENT';
  outbound.instantly_lead_id = 'lead_123';
  outbound.instantly_added_at = '2026-08-28T12:00:00.000Z';
  outbound.last_error = 'historic error';
  const outboundIndex = store.OUTBOUND.findIndex((r, index) => index > 1 && r[OUTBOUND_HEADER.indexOf('probe_id')] === 'prb_nightly');
  store.OUTBOUND[outboundIndex] = row(OUTBOUND_HEADER, outbound);
  process.env.CRON_SECRET = 'nightly-test-secret';
  process.env.INSTANTLY_API_KEY = 'nightly-instantly-key';
  process.env.INSTANTLY_CAMPAIGN_ID = 'nightly-campaign';
  await finalizeHandler({ method: 'GET', headers: { authorization: 'Bearer nightly-test-secret' } }, res);
  outbound = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_nightly');
  assert.equal(outbound.outbound_status, 'SENT');
  assert.equal(outbound.instantly_lead_id, 'lead_123');
  outbound.outbound_status = 'SUPPRESSED';
  store.OUTBOUND[outboundIndex] = row(OUTBOUND_HEADER, outbound);
  process.env.CRON_SECRET = 'nightly-test-secret';
  process.env.INSTANTLY_API_KEY = 'nightly-instantly-key';
  process.env.INSTANTLY_CAMPAIGN_ID = 'nightly-campaign';
  await finalizeHandler({ method: 'GET', headers: { authorization: 'Bearer nightly-test-secret' } }, res);
  outbound = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_nightly');
  assert.equal(outbound.outbound_status, 'SUPPRESSED');
  assert.equal(outbound.instantly_lead_id, 'lead_123');
  assert.equal(outbound.instantly_added_at, '2026-08-28T12:00:00.000Z');
  assert.equal(outbound.last_error, 'historic error');

  // The Google Sheet button calls this protected full-rebuild handler. Reset
  // OUTBOUND so this independently proves it writes a READY row through the
  // same post-DEMOS compiler rather than a separate implementation.
  store.OUTBOUND = [OUTBOUND_HEADER.slice(), ['SCHEMA NOTE', 'Fixture']];
  const oldAuthUser = process.env.NOVUS_BASIC_AUTH_USER;
  const oldAuthPass = process.env.NOVUS_BASIC_AUTH_PASS;
  process.env.NOVUS_BASIC_AUTH_USER = 'nightly-test-user';
  process.env.NOVUS_BASIC_AUTH_PASS = 'nightly-test-pass';
  const basic = Buffer.from('nightly-test-user:nightly-test-pass').toString('base64');
  await rebuildAllHandler({ method: 'POST', headers: { authorization: `Basic ${basic}` }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(response.demos, 'full rebuild completed its DEMOS stage');
  assert.equal(response.outbound.dry_run, false);
  assert.equal(response.outbound.create_count, 1);
  outbound = findRow(store, 'OUTBOUND', OUTBOUND_HEADER, 'prb_nightly');
  assert.equal(outbound.outbound_status, 'READY');
  if (oldAuthUser === undefined) delete process.env.NOVUS_BASIC_AUTH_USER; else process.env.NOVUS_BASIC_AUTH_USER = oldAuthUser;
  if (oldAuthPass === undefined) delete process.env.NOVUS_BASIC_AUTH_PASS; else process.env.NOVUS_BASIC_AUTH_PASS = oldAuthPass;
  if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  if (oldBatchSize === undefined) delete process.env.NOVUS_REBUILD_BATCH_SIZE; else process.env.NOVUS_REBUILD_BATCH_SIZE = oldBatchSize;
  if (oldInstantlyKey === undefined) delete process.env.INSTANTLY_API_KEY; else process.env.INSTANTLY_API_KEY = oldInstantlyKey;
  if (oldInstantlyCampaign === undefined) delete process.env.INSTANTLY_CAMPAIGN_ID; else process.env.INSTANTLY_CAMPAIGN_ID = oldInstantlyCampaign;
  ok('03:00 finalize preserves the existing pipeline, rebuilds OUTBOUND after DEMOS, then hands eligible READY rows to Instantly; the Google Sheet rebuild remains non-sending');
  console.log(`\n${passed} checks passed.`);
}

const selectedRun = process.env.NOVUS_ONLY_NIGHTLY_OUTBOUND_TEST ? runNightlyOutboundOnly : run;
selectedRun().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
