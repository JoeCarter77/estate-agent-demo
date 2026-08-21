// scripts/novus-email-assembly-selftest.mjs — hermetic test (no network, no
// creds, no AI) for lib/email-assembly.mjs: the deterministic assembler that
// turns ONE finalised PERSONALISATION row into the final outreach email.
//
// Personalisation writes the sentences; this layer decides the shape. So this
// suite proves the shape, and only the shape:
//   - the locked normal structure, in the locked order, with the locked CTA
//   - the separate no-response structure, which exists because a probe that
//     was never replied to has no conversation to describe
//   - optional paragraphs are omitted entirely, never left as blank gaps
//   - "That meant " is the ONE piece of grammar assembled in code
//   - merge fields: enquiry_date and property_address are resolved here,
//     {{first_name}} deliberately is not
//   - a row that cannot make a complete, honest email assembles nothing at
//     all, rather than an email with a hole in it
//   - nothing in here rewrites a sentence Personalisation wrote
//
// Run: npm run novus:email-assembly-selftest

import assert from 'node:assert';
import {
  assembleEmail, isSendable, normaliseVariant, openingLine,
  ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE, FIRST_NAME_MERGE_FIELD, NO_REPLY_LINE,
  NO_RESPONSE_BREAKDOWN_LINE, NO_RESPONSE_CTA_LINE, SIGN_OFF, THAT_MEANT_PREFIX,
} from '../lib/email-assembly.mjs';

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// The worked example from the brief: a fast, persistent agency whose
// follow-ups all handed the next step back to us, with a seller opportunity
// sitting unexplored inside the same enquiry.
function fullRow(overrides = {}) {
  return {
    email_variant: 'normal',
    enquiry_date: '18 August',
    property_address: '14 Oak Road',
    fair_observation: 'You got back to me quickly and followed up three times across phone and email.',
    main_finding: 'What stood out, though, was that each follow-up essentially asked me to get back to you, rather than giving me a clear next step. I had also mentioned a property of my own that I was considering selling, but that never really came into the conversation.',
    commercial_consequence: "the £425,000 enquiry wasn't just a potential buyer — there was also a potential seller instruction sitting inside it that never got explored.",
    wider_consequence: '',
    additional_findings_hook: ADDITIONAL_FINDINGS_HOOK_LINE,
    ...overrides,
  };
}

function noResponseRow(overrides = {}) {
  return {
    email_variant: 'no_response',
    enquiry_date: '18 August',
    property_address: '14 Oak Road',
    // Both forced empty upstream: there was no conversation to observe or
    // narrate. A row that carries them anyway must still not print them.
    fair_observation: '',
    main_finding: '',
    commercial_consequence: 'a buyer who was ready to view never got as far as a conversation.',
    wider_consequence: 'It also meant the property I said I had of my own was never picked up as a valuation.',
    additional_findings_hook: '',
    ...overrides,
  };
}

function run() {
  console.log('lib/email-assembly.mjs — hermetic selftest\n');

  // ── The locked normal structure, exactly ──
  {
    const body = assembleEmail(fullRow());
    const row = fullRow();
    assert.strictEqual(body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 18 August about 14 Oak Road.',
      row.fair_observation,
      row.main_finding,
      `That meant ${row.commercial_consequence}`,
      ADDITIONAL_FINDINGS_HOOK_LINE,
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('the normal structure assembles exactly as locked: intro, fair observation, main finding, "That meant" consequence, the additional-findings tease, the locked CTA, sign-off');
  }

  // ── The CTA is locked copy, and is never called an audit ──
  {
    const body = assembleEmail(fullRow());
    assert.ok(body.includes(CTA_LINE), 'the locked CTA is present verbatim');
    assert.ok(!/audit/i.test(body), 'the email never calls it an audit');
    assert.ok(!/free of charge|no charge|no obligation/i.test(body), 'and makes no offer beyond sending the breakdown over');
    assert.ok(body.endsWith(`\n\n${SIGN_OFF}`), 'it signs off as Joe');
    ok('the call to action is the locked breakdown line — never an audit, never a sales offer');
  }

  // ── Optional paragraphs are omitted, never left as blank gaps ──
  {
    const minimal = assembleEmail(fullRow({
      fair_observation: '', wider_consequence: '', additional_findings_hook: '',
    }));
    const row = fullRow();
    assert.strictEqual(minimal, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 18 August about 14 Oak Road.',
      row.main_finding,
      `That meant ${row.commercial_consequence}`,
      CTA_LINE,
      'Joe',
    ].join('\n\n'));
    assert.ok(!/\n\n\n/.test(minimal), 'no blank gap is left where an optional paragraph would have been');
    ok('every optional paragraph is dropped entirely when empty — the email closes up rather than showing a gap');
  }

  // ── A wider consequence gets its own paragraph, after the first one ──
  {
    const body = assembleEmail(fullRow({
      commercial_consequence: 'the enquiry was getting attention, but it was not really being progressed.',
      wider_consequence: 'It also meant a potential seller instruction mentioned in the same enquiry was never explored.',
    }));
    assert.ok(body.indexOf(THAT_MEANT_PREFIX) < body.indexOf('It also meant'), 'the wider consequence follows the first one');
    assert.ok(body.includes('\n\nIt also meant a potential seller instruction mentioned in the same enquiry was never explored.\n\n'),
      'and stands as its own paragraph');
    ok('a wider consequence is its own paragraph, immediately after the "That meant" consequence it widens');
  }

  // ── "That meant " is the ONE piece of grammar assembled in code ──
  {
    const body = assembleEmail(fullRow({ commercial_consequence: 'the valuation was never offered.' }));
    assert.ok(body.includes('That meant the valuation was never offered.'), 'the prefix and the continuation read as one sentence');
    assert.strictEqual((body.match(/That meant/g) || []).length, 1, 'and it appears exactly once');
    ok('"That meant " is hard-coded here and nowhere else, joining onto the continuation Personalisation returns');
  }

  // ── Nothing here rewrites a sentence Personalisation wrote ──
  {
    const row = fullRow({
      fair_observation: 'you came back fast',           // no capital, no full stop
      main_finding: 'each follow-up asked me to chase',  // ditto
    });
    const body = assembleEmail(row);
    assert.ok(body.includes('\n\nyou came back fast\n\n'), 'the fair observation is passed through byte-for-byte');
    assert.ok(body.includes('\n\neach follow-up asked me to chase\n\n'), 'and so is the main finding');
    ok('the assembler never repairs, capitalises or punctuates a sentence — sentence-ready copy is Personalisation\'s contract, not this layer\'s job');
  }

  // ── The no-response structure ──
  {
    const body = assembleEmail(noResponseRow());
    const row = noResponseRow();
    assert.strictEqual(body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 18 August about 14 Oak Road.',
      'We never received a reply.',
      `That meant ${row.commercial_consequence}`,
      row.wider_consequence,
      "We found a couple of things that may explain it, so we've put together a short breakdown that might be useful.",
      "Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('the no-response structure assembles as its own fixed shape: the plain no-reply line, the consequence, the wider consequence, and a closing that makes sense when there was no conversation');
  }

  // ── The no-response case never describes a conversation, and never
  //    stacks the "couple of other things" tease on top of its own closing ──
  {
    const body = assembleEmail(noResponseRow({
      // A row that (wrongly) still carries normal-case copy must not print it.
      fair_observation: 'You came back to me quickly.',
      main_finding: 'The reply did not mention the property.',
      additional_findings_hook: ADDITIONAL_FINDINGS_HOOK_LINE,
    }));
    assert.ok(!body.includes('You came back to me quickly.'), 'a stray fair observation is not printed');
    assert.ok(!body.includes('The reply did not mention the property.'), 'nor a stray main finding — there was no reply to describe');
    assert.ok(!body.includes(ADDITIONAL_FINDINGS_HOOK_LINE), 'and the tease is not stacked on top of the breakdown line that already says it');
    assert.ok(!body.includes(CTA_LINE), 'the normal CTA is not used');
    assert.ok(body.includes(NO_RESPONSE_BREAKDOWN_LINE) && body.includes(NO_RESPONSE_CTA_LINE), 'the no-response closing is');
    assert.strictEqual((body.match(/couple of/g) || []).length, 1, 'so "a couple of things" is offered exactly once');
    ok('the no-response structure prints only what is true of silence — no conversation, no duplicated tease, and its own closing');
  }

  // ── Merge fields ──
  {
    const body = assembleEmail(fullRow());
    assert.ok(body.startsWith(`Hi ${FIRST_NAME_MERGE_FIELD},`), '{{first_name}} is left as a merge token for the sending tool');
    assert.strictEqual((body.match(/\{\{/g) || []).length, 1, 'and it is the ONLY unresolved merge field in the email');
    assert.ok(body.includes('We sent your team an enquiry on 18 August about 14 Oak Road.'),
      'the date and address are resolved here, from the probe\'s own facts');
    assert.strictEqual(openingLine('1 January', 'Silence Road'), 'We sent your team an enquiry on 1 January about Silence Road.');
    ok('the assembler resolves enquiry_date and property_address itself and leaves exactly one merge field, {{first_name}}, for the sending tool');
  }

  // ── A row that cannot make a complete, honest email makes none ──
  {
    for (const [why, row] of [
      ['no property address', fullRow({ property_address: '' })],
      ['no enquiry date', fullRow({ enquiry_date: '' })],
      ['no commercial consequence', fullRow({ commercial_consequence: '' })],
      ['no main finding in the normal structure', fullRow({ main_finding: '' })],
      ['no commercial consequence in the no-response structure', noResponseRow({ commercial_consequence: '' })],
    ]) {
      assert.strictEqual(isSendable(row), false, `${why}: not sendable`);
      assert.strictEqual(assembleEmail(row), '', `${why}: assembles nothing at all`);
    }
    // The no-response structure needs no main finding — that is the point.
    assert.strictEqual(isSendable(noResponseRow({ main_finding: '' })), true, 'the no-response structure needs no main finding');
    assert.ok(assembleEmail(noResponseRow({ main_finding: '' })), 'and still assembles');
    assert.strictEqual(assembleEmail(null), '', 'a missing row assembles nothing');
    assert.strictEqual(assembleEmail({}), '', 'and so does an empty one');
    ok('a row missing anything its structure needs assembles no email at all — a blank email_body is the signal that a human should look, never a half-written email');
  }

  // ── An unrecognised variant is a normal email, never a silent reshape ──
  {
    assert.strictEqual(normaliseVariant('no_response'), 'no_response');
    assert.strictEqual(normaliseVariant('normal'), 'normal');
    assert.strictEqual(normaliseVariant(''), 'normal');
    assert.strictEqual(normaliseVariant(undefined), 'normal');
    assert.strictEqual(normaliseVariant('NO_RESPONSE'), 'normal', 'only the exact marker switches structure');
    assert.ok(assembleEmail(fullRow({ email_variant: 'something_else' })).includes(fullRow().main_finding),
      'an unknown variant still assembles the normal, conversation-describing email');
    assert.ok(!assembleEmail(fullRow({ email_variant: '' })).includes(NO_REPLY_LINE),
      'and never claims we received no reply when the row describes a conversation');
    ok('only the exact no_response marker switches structure — an unknown or missing variant assembles a normal email rather than silently claiming silence');
  }

  console.log(`\n${passed} checks passed.`);
}

try {
  run();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
}
