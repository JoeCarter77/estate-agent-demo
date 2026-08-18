// scripts/novus-intelligence-integration-selftest.mjs — hermetic tests for the
// INTEGRATION gaps in PROBES -> COMMUNICATIONS -> classification/evidence ->
// INTELLIGENCE -> grading -> DIAGNOSIS. No network, no creds.
//
// Each block below corresponds to one gap that made "Rebuild Intelligence"
// complete successfully while leaving the Intelligence tab mostly blank. The
// individual detectors were already unit-tested (novus-vendor-intent-selftest,
// novus-communication-quality-selftest, novus-proactive-booking-push-selftest);
// what was never tested was whether the rebuild actually REACHED them and
// wrote what they produced. That is what this file covers.
//
// Run: npm run novus:intelligence-integration-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';
import { recomputeProbeObservation } from '../lib/observation-recompute.mjs';
import { readVendorStatus } from '../lib/vendor-intent.mjs';
import { computeDiagnosis } from '../lib/diagnosis.mjs';

const PROBES_HEADER = [
  'probe_id','probe_reference','agency_id','portal','property_address','property_url',
  'property_price','property_status','enquiry_text','probe_email','probe_phone',
  'probe_timestamp','observation_deadline','probe_status','compromised','compromise_reason',
  'observation_closed_at','sent_from','observation_notes','created_at','updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id','agency_id','probe_id','interaction_id','occurred_at','received_at','channel',
  'direction','communication_type','provider','provider_event_id','source_identifier_raw',
  'source_identifier_normalized','destination_identifier','display_name','call_status',
  'duration_seconds','voicemail_present','recording_reference','transcript','email_message_id',
  'email_thread_id','subject','body_text','raw_content','raw_payload_reference','matching_method',
  'match_score','match_status','automated_or_human','human_contact','callback_attempt',
  'successful_conversation','follow_up','booking_attempt','communication_classification','intent',
  'contact_quality','ai_summary','ai_confidence','ai_model','manual_review_status','manual_override',
  'override_reason','created_at','updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id','agency_id','probe_id','observation_status','observation_deadline',
  'auto_acknowledgement','auto_ack_timestamp','crm_detected','crm_name','crm_evidence',
  'first_human_touch','first_human_touch_at','human_lag_hours','callback_attempts',
  'successful_conversations','voicemail_count','inbound_sms_count','email_touch_count',
  'follow_up_count','follow_up_channels','last_touch_at','days_chased','booking_attempt',
  'contact_quality','proactive_reactive','persistence_profile','channels_used','grade',
  'grade_reason','tier','tier_reason','sales_angle','segment','ai_evidence_summary','ai_confidence',
  'manual_override','override_reason','observation_closed_at','created_at','updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id','agency_id','probe_id','grade','tier','primary_problem','evidence_summary',
  'commercial_implication','recommended_solution','sales_angle','created_at','updated_at',
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PROBE_SENT = '2026-08-01T09:00:00.000Z';
const VENDOR_ENQUIRY = 'Interested in viewing. Also declared: has a property to sell — it is not yet on the market.';
const PLAIN_ENQUIRY = 'Interested in viewing this property.';

function iso(offsetMs, from = PROBE_SENT) { return new Date(new Date(from).getTime() + offsetMs).toISOString(); }

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
    DIAGNOSIS: [DIAGNOSIS_HEADER.slice(), ['SCHEMA NOTE', 'Commercial read of a closed Intelligence record.']],
  };
  const tabOf = (r) => String(r).split('!')[0];
  const startRowOf = (r) => { const m = String(r).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; };
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return {};
    },
    async update(range, rows) {
      const tab = tabOf(range);
      const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => {
        const idx = start - 1 + i;
        while (store[tab].length <= idx) store[tab].push([]);
        const existing = store[tab][idx] || [];
        r.forEach((v, c) => { existing[c] = v; });
        store[tab][idx] = existing;
      });
      return {};
    },
    async batchUpdate(data) { for (const { range, values } of data) await this.update(range, values); return {}; },
  };
  return { store, valuesApi };
}

let seq = 0;
function seedProbe(store, patch) {
  seq += 1;
  const obj = {
    probe_id: `prb_it_${seq}`, agency_id: `agc_it_${seq}`, portal: 'rightmove',
    enquiry_text: PLAIN_ENQUIRY, probe_timestamp: PROBE_SENT,
    observation_deadline: iso(4 * DAY), probe_status: 'sent', ...patch,
  };
  store.PROBES.push(PROBES_HEADER.map((k) => obj[k] ?? ''));
  return obj.probe_id;
}

function seedComm(store, patch) {
  seq += 1;
  const obj = {
    communication_id: `com_it_${seq}`, channel: 'email', direction: 'inbound',
    occurred_at: iso(HOUR), match_status: 'matched', matching_method: 'deterministic', ...patch,
  };
  store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((k) => obj[k] ?? ''));
  return obj.communication_id;
}

function readRecords(store, tab, idColumn) {
  const header = store[tab][0];
  const idIdx = header.indexOf(idColumn);
  return store[tab].slice(1)
    .filter((r) => r[idIdx] && r[idIdx] !== 'SCHEMA NOTE')
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}
const commById = (store, id) => readRecords(store, 'COMMUNICATIONS', 'communication_id').find((c) => c.communication_id === id);
const intelFor = (store, pid) => readRecords(store, 'INTELLIGENCE', 'intelligence_id').find((r) => r.probe_id === pid);
const diagFor = (store, pid) => readRecords(store, 'DIAGNOSIS', 'diagnosis_id').find((r) => r.probe_id === pid);

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

async function run() {
  // ── GAP 1: previously-classified rows were skipped entirely ────────────────
  console.log('\nGAP 1 — already-classified COMMUNICATIONS rows are re-processed by the current logic');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    // Exactly the historical/production shape: automated_or_human already
    // decided by an earlier deploy, every derived column left blank.
    const pid = seedProbe(store, { enquiry_text: PLAIN_ENQUIRY });
    const cid = seedComm(store, {
      probe_id: pid, automated_or_human: 'human', human_contact: 'TRUE',
      subject: 'Re: your enquiry',
      body_text: 'We tried to call you about your enquiry. Are you available to view at 10am Friday morning?',
    });

    await rebuildAllIntelligence(repo);
    const comm = commById(store, cid);

    assert.strictEqual(comm.communication_classification, 'reactive', 'communication_classification written on a previously-classified row');
    assert.strictEqual(comm.contact_quality, 'proactive_booking_push', 'contact_quality written on a previously-classified row');
    assert.strictEqual(comm.automated_or_human, 'human', 'the existing human/automated decision is preserved, not re-litigated');
    ok('a row that already carried automated_or_human now gets every derived column filled in (the isClassified() guard is gone)');
  }

  // ── GAP 2: each signal lands in its own existing column ───────────────────
  console.log('\nGAP 2 — communication_classification / intent / contact_quality land in their correct existing columns');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    const pid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    const cid = seedComm(store, {
      probe_id: pid, automated_or_human: 'human', human_contact: 'TRUE',
      body_text: 'Regarding your enquiry — we can offer a free valuation. Are you free Saturday at 3pm?',
    });

    await rebuildAllIntelligence(repo);
    const comm = commById(store, cid);

    assert.strictEqual(comm.communication_classification, 'reactive', 'human message quality -> communication_classification');
    assert.strictEqual(comm.intent, 'vendor_discussed', 'vendor signal -> intent');
    assert.strictEqual(comm.contact_quality, 'proactive_booking_push', 'proactive booking push -> COMMUNICATIONS.contact_quality');
    ok('all three signals are written simultaneously, each to its own existing column, none overwriting another');
  }

  // ── GAP 3: the two contact_quality columns must stay separate ─────────────
  console.log('\nGAP 3 — COMMUNICATIONS.contact_quality and INTELLIGENCE.contact_quality stay distinct');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    const pid = seedProbe(store, {});
    const cid = seedComm(store, {
      probe_id: pid, automated_or_human: 'human', human_contact: 'TRUE',
      body_text: 'Would you like to book a viewing? Let me know your availability.',
    });

    await rebuildAllIntelligence(repo);
    const comm = commById(store, cid);
    const intel = intelFor(store, pid);

    assert.strictEqual(comm.contact_quality, 'proactive_booking_push', 'the per-row column carries the per-row signal');
    assert.notStrictEqual(intel.contact_quality, 'proactive_booking_push', 'the probe-level rollup is NOT overwritten with the per-row value');
    assert.strictEqual(intel.contact_quality, 'Booking attempt', 'the probe-level rollup keeps its own §18 enum');
    ok('proactive_booking_push stays in COMMUNICATIONS.contact_quality and never leaks into the probe-level INTELLIGENCE.contact_quality');
  }

  // ── GAP 4: proactive_reactive was never written at all ────────────────────
  console.log('\nGAP 4 — INTELLIGENCE.proactive_reactive is populated');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    const reactivePid = seedProbe(store, {});
    seedComm(store, { probe_id: reactivePid, automated_or_human: 'human', human_contact: 'TRUE', body_text: 'The property is still available.' });

    const proactivePid = seedProbe(store, {});
    seedComm(store, { probe_id: proactivePid, automated_or_human: 'human', human_contact: 'TRUE', body_text: 'Can you do Saturday at 3pm?' });

    const silentPid = seedProbe(store, {});

    await rebuildAllIntelligence(repo);

    assert.strictEqual(intelFor(store, reactivePid).proactive_reactive, 'reactive', 'single responding touch -> reactive');
    assert.strictEqual(intelFor(store, proactivePid).proactive_reactive, 'proactive', 'a push for a specific slot -> proactive');
    assert.strictEqual(intelFor(store, silentPid).proactive_reactive, 'none', 'no human contact -> none, never blank');
    ok('proactive_reactive is written for every probe, in its own column, distinct from contact_quality');
  }

  // ── GAP 5: vendor findings must roll up into INTELLIGENCE ─────────────────
  console.log('\nGAP 5 — vendor opportunity is detected from PROBES.enquiry_text and rolls up into INTELLIGENCE');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    const progressedPid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    seedComm(store, {
      probe_id: progressedPid, channel: 'voice', automated_or_human: 'human', human_contact: 'TRUE',
      transcript: 'Our valuer will call you to arrange a valuation of your property.',
    });

    const missedPid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    seedComm(store, { probe_id: missedPid, automated_or_human: 'human', human_contact: 'TRUE', body_text: 'The property is still available.' });

    const noDeclPid = seedProbe(store, { enquiry_text: PLAIN_ENQUIRY });
    seedComm(store, { probe_id: noDeclPid, automated_or_human: 'human', human_contact: 'TRUE', body_text: 'We can offer a free valuation of your property.' });

    await rebuildAllIntelligence(repo);

    assert.strictEqual(readVendorStatus(intelFor(store, progressedPid).ai_evidence_summary), 'progressed', 'acknowledged/discussed/progressed rolls up to INTELLIGENCE');
    assert.strictEqual(readVendorStatus(intelFor(store, missedPid).ai_evidence_summary), 'no_evidence', 'a declared vendor opportunity nobody acted on rolls up as no_evidence');
    assert.strictEqual(readVendorStatus(intelFor(store, noDeclPid).ai_evidence_summary), '', 'a probe that never declared a vendor opportunity carries no vendor status');
    ok('the Rightmove vendor declaration in PROBES.enquiry_text drives a vendor status on the INTELLIGENCE row');
  }

  // ── GAP 6: ai_evidence_summary was blank on every non-vendor probe ────────
  console.log('\nGAP 6 — ai_evidence_summary reflects the real evidence, for every probe');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    // A voicemail matching NO deterministic phrase rule at all — previously
    // this produced an entirely blank ai_evidence_summary.
    const pid = seedProbe(store, { enquiry_text: PLAIN_ENQUIRY });
    seedComm(store, {
      probe_id: pid, channel: 'voice', automated_or_human: 'human', human_contact: 'TRUE',
      transcript: 'Hi there. Yeah the place is still on. Anyway, speak soon.',
    });

    await rebuildAllIntelligence(repo);
    const summary = intelFor(store, pid).ai_evidence_summary;

    assert.notStrictEqual(summary, '', 'a non-vendor probe still gets an evidence summary');
    assert.match(summary, /Response: first human contact/, 'the summary states when a person actually made contact');
    assert.match(summary, /Persistence:/, 'the summary states attempts/follow-ups/channels');
    assert.match(summary, /speak soon/, 'evidence matching NO deterministic rule is still quoted rather than discarded');
    assert.match(summary, /voice/, 'the summary names the channel the evidence came from');
    ok('useful evidence in a call/email/SMS survives even when it matches none of the narrow deterministic rules');
  }

  // ── GAP 7: grading must stay a pure speed/persistence measure ─────────────
  console.log('\nGAP 7 — A-H grading is unaffected by any of the above');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    // Identical timing/persistence evidence; one carries every extra signal
    // (vendor, booking push, reactive phrasing), the other carries none.
    const richPid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    seedComm(store, {
      probe_id: richPid, automated_or_human: 'human', human_contact: 'TRUE', occurred_at: iso(30 * 60 * 1000),
      body_text: 'Regarding your enquiry — free valuation available, and I can do Saturday at 3pm.',
    });
    const barePid = seedProbe(store, { enquiry_text: PLAIN_ENQUIRY });
    seedComm(store, {
      probe_id: barePid, automated_or_human: 'human', human_contact: 'TRUE', occurred_at: iso(30 * 60 * 1000),
      body_text: 'Yes it is available.',
    });

    await rebuildAllIntelligence(repo);

    const rich = intelFor(store, richPid);
    const bare = intelFor(store, barePid);
    assert.strictEqual(rich.grade, bare.grade, 'the extra evidence signals do not move the A-H grade');
    assert.strictEqual(rich.grade, 'C', 'both are C: very fast human contact, zero follow-up attempts');
    assert.match(rich.grade_reason, /Source Master §10/, 'the grade reason still comes from the grading engine alone');
    ok('vendor intent, booking pushes and evidence summaries never contaminate the A-H grade');
  }

  // ── GAP 8: Diagnosis defaulted to "None observed" for A/B ─────────────────
  console.log('\nGAP 8 — Diagnosis uses the Intelligence evidence instead of defaulting to None');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);

    // Grade A: fast human contact WITH a follow-up attempt — but the declared
    // vendor opportunity is never once mentioned.
    const pid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY, observation_deadline: iso(-1 * DAY) });
    seedComm(store, {
      probe_id: pid, automated_or_human: 'human', human_contact: 'TRUE', occurred_at: iso(20 * 60 * 1000),
      body_text: 'Yes, still available. Can you do Saturday at 3pm?',
    });
    seedComm(store, {
      probe_id: pid, channel: 'voice', automated_or_human: 'human', human_contact: 'TRUE', occurred_at: iso(5 * HOUR),
      transcript: 'Just chasing up on the viewing, give me a call back.',
    });

    await rebuildAllIntelligence(repo);
    await rebuildAllDiagnosis(repo);

    const intel = intelFor(store, pid);
    const diag = diagFor(store, pid);

    assert.strictEqual(intel.grade, 'A', 'the grade itself is still A — strong speed and persistence');
    assert.strictEqual(diag.grade, 'A', 'DIAGNOSIS keeps the same grade');
    assert.strictEqual(diag.tier, 'Growth', 'A/B still routes to Growth — the routing table is untouched');
    assert.doesNotMatch(diag.primary_problem, /^None observed/i, 'a Grade A probe no longer reports "None observed"');
    assert.match(diag.primary_problem, /vendor opportunity was never picked up/i, 'it reports the real, evidence-backed commercial problem instead');
    assert.match(diag.evidence_summary, /Vendor opportunity: no_evidence/, 'the Intelligence evidence reaches the Diagnosis row');
    ok('a strong A-H grade with a missed vendor opportunity produces a real Diagnosis, not a blank one');
  }

  // ── GAP 9: multiple weaknesses must all be preserved ─────────────────────
  console.log('\nGAP 9 — several weaknesses are all preserved; the most commercially important becomes primary');
  {
    const intelligence = {
      grade: 'A', grade_reason: 'Very fast human contact.', first_human_touch: 'yes',
      booking_attempt: 'FALSE', proactive_reactive: 'reactive', follow_up_count: '0',
      ai_evidence_summary: 'Vendor opportunity: no_evidence. 2 human communication(s) reviewed; none referenced the declared vendor opportunity or a valuation.',
    };
    const diagnosis = computeDiagnosis(intelligence);

    assert.match(diagnosis.primary_problem, /vendor opportunity was never picked up/i, 'the vendor miss outranks the others commercially');
    assert.match(diagnosis.evidence_summary, /Also observed:/, 'the other weaknesses are kept, not thrown away');
    assert.match(diagnosis.evidence_summary, /no viewing or valuation was ever proposed/i, 'the missed booking is retained');
    assert.match(diagnosis.evidence_summary, /purely reactive/i, 'the reactive-only posture is retained');
    ok('every supported weakness is retained on the Diagnosis row, ranked by commercial importance');
  }

  // ── GAP 10: both rebuild paths must agree ────────────────────────────────
  console.log('\nGAP 10 — the single-probe/webhook path produces the same result as the batch rebuild');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    __setRepoForTests(repo);

    const pid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    const cid = seedComm(store, {
      probe_id: pid, automated_or_human: 'human', human_contact: 'TRUE',
      body_text: 'Regarding your enquiry — we can offer a free valuation. Saturday at 3pm?',
    });

    await recomputeProbeObservation(repo, pid);

    const comm = commById(store, cid);
    const intel = intelFor(store, pid);
    assert.strictEqual(comm.communication_classification, 'reactive', 'the webhook path also re-processes an already-classified row');
    assert.strictEqual(comm.intent, 'vendor_discussed', 'the webhook path writes intent');
    assert.strictEqual(comm.contact_quality, 'proactive_booking_push', 'the webhook path writes contact_quality');
    assert.strictEqual(intel.proactive_reactive, 'proactive', 'the webhook path writes proactive_reactive');
    assert.match(intel.ai_evidence_summary, /Vendor opportunity: discussed/, 'the webhook path writes the same evidence summary');
    ok('lib/observation-recompute.mjs and lib/intelligence-rebuild.mjs stay in lockstep — one shared interpretation, no drift');

    __setRepoForTests(null);
  }

  // ── GAP 11: repeated rebuilds must not churn the sheet ───────────────────
  console.log('\nGAP 11 — re-running the rebuild writes nothing new (still idempotent after the fixes)');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    const pid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    seedComm(store, {
      probe_id: pid, automated_or_human: 'human', human_contact: 'TRUE',
      body_text: 'Regarding your enquiry — free valuation, Saturday at 3pm?',
    });

    await rebuildAllIntelligence(repo);
    const after1 = JSON.stringify(store.COMMUNICATIONS);
    const intelRows1 = readRecords(store, 'INTELLIGENCE', 'intelligence_id').length;

    await rebuildAllIntelligence(repo);
    assert.strictEqual(JSON.stringify(store.COMMUNICATIONS), after1, 'a second rebuild changes no COMMUNICATIONS cell');
    assert.strictEqual(readRecords(store, 'INTELLIGENCE', 'intelligence_id').length, intelRows1, 'a second rebuild creates no duplicate INTELLIGENCE row');
    ok('reclassifying every row on every rebuild is still idempotent — only genuinely changed cells are ever written');
  }

  // ── GAP 12: manual overrides still win ───────────────────────────────────
  console.log('\nGAP 12 — manual_override rows are still never touched');
  {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    const pid = seedProbe(store, { enquiry_text: VENDOR_ENQUIRY });
    const cid = seedComm(store, {
      probe_id: pid, automated_or_human: 'automated', human_contact: 'FALSE',
      manual_override: 'TRUE', override_reason: 'reviewed by hand',
      communication_classification: '', contact_quality: '',
      body_text: 'Regarding your enquiry — free valuation, Saturday at 3pm?',
    });

    await rebuildAllIntelligence(repo);
    const comm = commById(store, cid);
    assert.strictEqual(comm.automated_or_human, 'automated', 'the overridden human/automated decision is untouched');
    assert.strictEqual(comm.communication_classification, '', 'no classification is forced onto an overridden row');
    assert.strictEqual(comm.contact_quality, '', 'no contact_quality is forced onto an overridden row');
    assert.strictEqual(comm.intent, '', 'no intent is forced onto an overridden row');
    ok('the Source Master §19 override rule still holds after the reclassification change');
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
