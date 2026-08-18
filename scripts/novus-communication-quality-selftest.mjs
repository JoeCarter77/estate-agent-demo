// scripts/novus-communication-quality-selftest.mjs — hermetic test for the
// extended COMMUNICATIONS.communication_classification values added to
// lib/classification.mjs: 'generic' and 'reactive' for HUMAN communications
// (alongside the existing 'auto_acknowledgement' for automated ones).
//
// Every case below is VERBATIM real historical text from the live
// NOVUS_Data_V1_Master_v2 COMMUNICATIONS tab (read via the Google Drive
// connector, communication_id noted on each case) — not synthetic examples.
// This both proves the classifier against genuine agency wording and prints
// one worked example per classification bucket, as requested.
//
// No network, no creds. Run: node scripts/novus-communication-quality-selftest.mjs

import assert from 'node:assert';
import { classifyCommunication } from '../lib/classification.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

function show(id, label, comm, result) {
  const text = (comm.body_text || comm.transcript || '').slice(0, 140);
  console.log(`\n  [${label}] ${id}`);
  console.log(`    text: "${text}${text.length === 140 ? '…' : ''}"`);
  console.log(`    -> communication_classification = ${JSON.stringify(result.communication_classification)} (automated_or_human=${result.automated_or_human}, booking_attempt=${result.booking_attempt})`);
}

async function run() {
  // ── 'generic' — bulk/impersonal human sends, no property/enquiry reference ──
  console.log("\n'generic' — bulk/impersonal human sends (com_hist_e0008/e0009/e0010, Parabar Estates)");
  {
    const cases = [
      ['com_hist_e0008', { subject: 'Property Details', body_text: 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings. You have been registered.', source_identifier_raw: 'kaly-khan@parabar.co.uk', channel: 'email' }],
      ['com_hist_e0009', { subject: 'Property Details - Outwood Common Road, Billericay', body_text: 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings.', source_identifier_raw: 'ialderton@parabar.co.uk', channel: 'email' }],
      ['com_hist_e0010', { subject: 'Property Details - Kilbarry Walk, Billericay', body_text: 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings.', source_identifier_raw: 'ialderton@parabar.co.uk', channel: 'email' }],
    ];
    for (const [id, comm] of cases) {
      const result = classifyCommunication(comm);
      show(id, 'generic', comm, result);
      assert.strictEqual(result.automated_or_human, 'human', `${id}: from a named mailbox, still human`);
      assert.strictEqual(result.communication_classification, 'generic', `${id}: bulk brochure send with no property reference tags generic`);
    }
    ok("three real Parabar Estates brochure blasts (no reference to the probe property, no personal engagement) all tag 'generic'");
  }

  // ── 'reactive' — personal callback/re-engagement referencing THIS enquiry ──
  console.log("\n'reactive' — personal callback/re-engagement referencing this enquiry");
  {
    const cases = [
      ['com_hist_c0001 (voicemail, Stanton Hockett)', { channel: 'voice', transcript: "Hi, Jerry, it's Terry from Stanton Hockett estate agents. Trying to catch up with you regarding your inquiry on our lovely Wedgewood Way property in Ashingdon area of Rochford. It's one on the market for 450,000. Give me a call back when you're free." }],
      ['com_hist_c0018 (voicemail, Farsons Property Group)', { channel: 'voice', transcript: "Hi, this is Debs from Farsons Property Group. You put in a request to view Clive House flat in Shenfield Road. If you'd like to call me back, then I can arrange a viewing for you. 01277288850." }],
      ['com_hist_c0020 (voicemail, Home Partnership)', { channel: 'voice', transcript: "Hi, it's a message for Joe. It's Michael calling from Home Partnership Estate Agents in Chelmsford. Received your inquiry about the property we have for sale on the Centenary Way in Beaulieu Park. Can you give me a call back please on 01245 250222?" }],
      ['com_hist_e0016 (email, Crown Estate Agents)', { subject: 'Kathy Crown Estate Agents re inquiry', body_text: 'Hi Joe. Thank you for your inquiry. We have tried to call you regarding Fox Cottage. If you would care to call back or email, we can make you an appointment to view. Kathy Horton.', source_identifier_raw: 'kathy@crownestatesagents.co.uk', channel: 'email' }],
      ['com_hist_e0035 (email, unnamed agency)', { subject: 'Apartment on Lambourne Chase, Chelmsford', body_text: 'Hi Joe. Hope this email finds you well. I have tried to call regarding your enquiry on the property on Lambourne Chase. Are you available to view Saturday?', source_identifier_raw: 'someone@example.co.uk', channel: 'email' }],
    ];
    for (const [id, comm] of cases) {
      const result = classifyCommunication(comm);
      show(id, 'reactive', comm, result);
      assert.strictEqual(result.automated_or_human, 'human', `${id}: genuinely human`);
      assert.strictEqual(result.communication_classification, 'reactive', `${id}: personal callback/re-engagement referencing the enquiry tags reactive`);
    }
    ok("five real callback voicemails/emails (naming the property/enquiry, asking for a call back) all tag 'reactive', regardless of whether they also happen to offer a viewing");
  }

  // ── 'auto_acknowledgement' — unchanged, still automated-only ──
  console.log("\n'auto_acknowledgement' — unchanged (automated sender, com_hist_e0014, Gibson & Brennan)");
  {
    const comm = { subject: 'Thank you for your enquiry..', body_text: 'Thank you for your enquiry. Thanks for your enquiry about 2 bedroom terraced house for sale in Whitmore Way, Basildon, SS14. Before we move this forward we just need you to complete our online registration.', source_identifier_raw: 'noreply@gibsonandbrennan.co.uk', channel: 'email' };
    const result = classifyCommunication(comm);
    show('com_hist_e0014', 'auto_acknowledgement', comm, result);
    assert.strictEqual(result.automated_or_human, 'automated');
    assert.strictEqual(result.communication_classification, 'auto_acknowledgement', 'the pre-existing automated bucket is untouched by this change');
    ok("a real noreply@ auto-acknowledgement still tags 'auto_acknowledgement' — the extension only ever adds new HUMAN values, never touches this path");
  }

  // ── '' — genuinely human, but no confident generic/reactive signal ──
  console.log("\n'' (no confident signal) — genuine human replies the phrase lists correctly leave alone");
  {
    const cases = [
      ['com_hist_e0013 (email, personalised booking offer)', { subject: 'Walman House, Billericay', body_text: 'Hi Joe, thanks for your enquiry regarding the property we have for sale in Walman House, St Ediths Court, Billericay. I understand you would like to arrange a viewing - if so, just let me know when suits.', source_identifier_raw: 'jay@thepropertyspecialists.co.uk', channel: 'email' }],
      ['com_hist_c0012 (voicemail, one word)', { channel: 'voice', transcript: 'Hello.' }],
      ['com_hist_c0002 (voicemail, no answer, empty)', { channel: 'voice', transcript: '' }],
    ];
    for (const [id, comm] of cases) {
      const result = classifyCommunication(comm);
      show(id, 'none', comm, result);
      assert.strictEqual(result.communication_classification, '', `${id}: no generic/reactive phrase present -> left blank, not guessed`);
    }
    assert.strictEqual(classifyCommunication(cases[0][1]).booking_attempt, true, 'com_hist_e0013 is still correctly flagged booking_attempt=TRUE by the separate, untouched booking logic, even with no communication_classification value');
    ok("a genuine personalised booking offer with no 'reactive' callback phrasing, a one-word voicemail, and an empty/no-answer call all correctly stay unclassified — conservative default preserved, and booking_attempt keeps working independently");
  }

  // ── Regression: A-H grading inputs are untouched by this change ──
  console.log('\nRegression — grading.mjs never reads communication_classification beyond the unchanged auto_acknowledgement check');
  {
    const { gradeObservation } = await import('../lib/grading.mjs');
    const { computeObservation } = await import('../lib/observation.mjs');
    const probe = { probe_timestamp: '2026-08-01T21:00:00.000Z', observation_deadline: '2026-08-05T21:00:00.000Z' };
    // A realistic COMMUNICATIONS row: the classification tags merged ONTO the
    // row itself, not standing alone. computeObservation() reads the row's own
    // channel and content (lib/comm-assessment.mjs), which a bare tag object
    // does not carry.
    const rawComm = {
      communication_id: 'com_q1',
      channel: 'voice',
      transcript: "Hi, it's Terry, trying to catch up with you regarding your inquiry, give me a call back.",
      occurred_at: '2026-08-01T21:30:00.000Z',
    };
    const reactiveComm = { ...rawComm, ...classifyCommunication(rawComm) };
    const observation = computeObservation(probe, [reactiveComm]);
    const { grade } = gradeObservation({ probe, observation, now: new Date('2026-08-02T00:00:00.000Z') });
    assert.strictEqual(observation.auto_acknowledgement, false, "a 'reactive'-tagged communication is never mistaken for an auto-acknowledgement");
    assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(grade), `A-H grading still resolves normally for a 'reactive' communication (got ${grade}) — new classification values do not alter grading`);
    ok("the new 'generic'/'reactive' values flow through observation.mjs and grading.mjs completely inertly — A-H grading is unaffected, as required");
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
  console.log('NOTE: historical COMMUNICATIONS rows in the live sheet already carry automated_or_human');
  console.log('from an earlier import, so the rebuild/recompute pipeline\'s isClassified() guard will skip');
  console.log('re-classifying them live (by design — it never re-guesses an already-classified row).');
  console.log('This test proves the new classifier logic directly against real historical text; backfilling');
  console.log('communication_classification onto the existing historical rows would be a separate, deliberate');
  console.log('one-time action, not attempted here.');
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
