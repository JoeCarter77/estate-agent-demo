// scripts/novus-probe-interpretation-selftest.mjs — hermetic test (no
// network, no creds) for lib/probe-interpretation.mjs: the AI call that
// produces the eight AI-derived INTELLIGENCE fields (V2 schema §3), and —
// the part that matters most — the quote-validation guard that drops any
// claim the model can't back with a literal substring of the real message
// it cites.
//
// The AI itself is stubbed via lib/ai-client.mjs's __setAiCallerForTests();
// this suite tests the orchestration around it (validation, deterministic
// qualification-depth flooring, the zero-communications fallback, the
// vendor-declaration gate), not the model's judgement.
//
// Run: npm run novus:probe-interpretation-selftest

import assert from 'node:assert';
import { interpretProbe } from '../lib/probe-interpretation.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

const PROBE_NO_VENDOR = {
  probe_id: 'prb_001',
  property_address: '12 Example Road, Testbury',
  property_price: '£450,000',
  enquiry_text: 'Interested in viewing this property. Please call me back to arrange a time.',
};

const PROBE_VENDOR = {
  probe_id: 'prb_002',
  property_address: 'Barn Field, Chevington, IP29',
  property_price: '£375,000',
  enquiry_text: 'Rightmove property enquiry. Declared: has a property to sell, yes, it is not yet on the market; wants more details on this property.',
};

async function run() {
  console.log('lib/probe-interpretation.mjs — hermetic selftest\n');

  // ── Zero communications: no AI call needed, deterministic fallback ──
  {
    let aiCalled = false;
    __setAiCallerForTests(async () => { aiCalled = true; return {}; });
    const result = await interpretProbe(PROBE_NO_VENDOR, []);
    assert.strictEqual(aiCalled, false, 'zero communications never calls the AI');
    assert.strictEqual(result.viewing_progression, 'none');
    assert.strictEqual(result.buyer_qualification, 'none');
    assert.strictEqual(result.communication_quality, 'poor');
    assert.ok(result.missed.includes('No communication'), 'missed states plainly that nothing arrived');
    ok('zero communications produces a deterministic fallback with no AI call');
  }

  // ── Quote validation: a genuine quote survives, a hallucinated one is dropped ──
  {
    const comms = [
      {
        communication_id: 'com_001',
        channel: 'email',
        occurred_at: '2026-08-18T16:26:51.000Z',
        subject: 'Ensum Brown | Viewing Enquiry',
        body_text: "Thank you for your enquiry on Barn Field, Chevington, IP29. I'd be happy to arrange a viewing for you. What is the situation with your current property? Are you on the market or renting for example?",
      },
    ];
    __setAiCallerForTests(async ({ tool }) => {
      if (tool.name !== 'record_probe_interpretation') throw new Error('unexpected tool');
      return {
        viewing_progression: 'invited',
        buyer_questions_asked: [
          // Genuine — copied verbatim from the message above.
          { topic: 'current property position', quote: 'What is the situation with your current property? Are you on the market or renting for example?', communication_id: 'com_001' },
          // Hallucinated — never appears in the source. Must be dropped.
          { topic: 'timescale', quote: 'When are you looking to move by?', communication_id: 'com_001' },
        ],
        seller_recognition: 'asked_position',
        communication_quality: 'strong',
        did_well: 'Named the property and offered a viewing.',
        missed: 'No valuation was offered.',
        evidence: [
          { quote: "I'd be happy to arrange a viewing for you", communication_id: 'com_001' },
          { quote: 'This sentence was never sent', communication_id: 'com_001' },
        ],
      };
    });

    const result = await interpretProbe(PROBE_VENDOR, comms);
    assert.strictEqual(result.buyer_questions_asked, 'current property position', 'the hallucinated question topic is dropped, the genuine one survives');
    assert.strictEqual(result.buyer_qualification, 'minimal', '1 surviving question floors qualification depth to minimal, not whatever the model claimed');
    assert.ok(result.evidence.includes("arrange a viewing for you"), 'the genuine evidence quote survives');
    assert.ok(!result.evidence.includes('never sent'), 'the hallucinated evidence quote is dropped');
    ok('a genuine quote survives validation and a hallucinated one is silently dropped');
  }

  // ── seller_recognition is gated on the vendor declaration, regardless of what the AI returns ──
  {
    __setAiCallerForTests(async () => ({
      viewing_progression: 'none',
      buyer_questions_asked: [],
      seller_recognition: 'valuation_booked', // the AI should not even be asked this, but prove it's ignored
      communication_quality: 'generic',
      did_well: '',
      missed: '',
      evidence: [],
    }));
    const result = await interpretProbe(PROBE_NO_VENDOR, [
      { communication_id: 'com_002', channel: 'email', occurred_at: '2026-08-01T09:00:00Z', body_text: 'Sure, come round Saturday at 3pm.' },
    ]);
    assert.strictEqual(result.seller_recognition, '', 'no vendor declaration on the probe -> seller_recognition is blank, never populated from the model');
    ok('seller_recognition stays blank when the probe never declared a vendor opportunity, even if the model answers anyway');
  }

  // ── buyer_qualification floors deterministically from the surviving question count ──
  {
    const comms = [{ communication_id: 'com_003', channel: 'email', occurred_at: '2026-08-01T09:00:00Z', body_text: 'partner? address? finance? budget? requirements? areas? timescale? motivation?' }];
    const topics = ['partner', 'address', 'finance', 'budget', 'requirements', 'areas', 'timescale', 'motivation'];
    __setAiCallerForTests(async () => ({
      viewing_progression: 'none',
      buyer_questions_asked: topics.map((t) => ({ topic: t, quote: `${t}?`, communication_id: 'com_003' })),
      communication_quality: 'strong',
      did_well: '', missed: '', evidence: [],
    }));
    const result = await interpretProbe(PROBE_NO_VENDOR, comms);
    assert.strictEqual(result.buyer_qualification, 'thorough', '8 genuine questions -> thorough (6+)');
    ok('buyer_qualification is floored deterministically from the count of validated questions (thorough at 6+)');
  }

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
