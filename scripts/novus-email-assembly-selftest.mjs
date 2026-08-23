// scripts/novus-email-assembly-selftest.mjs — hermetic test (no network, no
// creds, no AI) for lib/email-assembly.mjs: the deterministic assembler that
// turns ONE finalised PERSONALISATION row into the final outreach email.
//
// Personalisation writes the sentences; this layer decides the shape. The
// shape is LOCKED, so this suite proves the shape, and only the shape:
//   - VARIANT 2 (normal), in the locked paragraph order
//   - VARIANT 1 (no response), which exists because a probe that was never
//     replied to has no conversation to describe
//   - the final two paragraphs — the curiosity transition and the CTA — are
//     locked, identical, and present in BOTH variants every time
//   - the FIXED OPENING WORDS this layer owns — "I want to say upfront that ",
//     "What stood out, though, was ", "That meant ", "That also meant " —
//     joined onto the lower-case continuations Personalisation returns, and
//     never printed twice
//   - the wider beat is a PAIR: no observation, no "That also meant"
//   - merge fields: enquiry_date and property_address are resolved here,
//     {{first_name}} deliberately is not
//   - THE SENDABILITY CONTRACT: a normal email needs fair_observation,
//     main_finding AND commercial_consequence, and a row missing any of them
//     assembles nothing at all rather than an email with a hole in it
//   - nothing in here rewrites a sentence Personalisation wrote
//
// Run: npm run novus:email-assembly-selftest

import assert from 'node:assert';
import {
  assembleEmail, isSendable, normaliseVariant, openingLine,
  ADDITIONAL_FINDINGS_HOOK_LINE, CTA_LINE, FIRST_NAME_MERGE_FIELD, NO_REPLY_LINE,
  SIGN_OFF, THAT_MEANT_PREFIX, THAT_ALSO_MEANT_PREFIX, FAIR_OBSERVATION_PREFIX,
  MAIN_FINDING_PREFIX, withPrefix, emailContractViolations,
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
    fair_observation: 'you got back to me quickly and followed up three times across phone and email.',
    main_finding: 'that each follow-up essentially asked me to get back to you, rather than giving me a clear next step.',
    commercial_consequence: "the £425,000 enquiry wasn't just a potential buyer — there was also a potential seller instruction sitting inside it that never got explored.",
    wider_observation: '',
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
    wider_observation: "I'd also said I had a property of my own I was thinking of selling.",
    wider_consequence: 'the valuation sitting inside the same enquiry was never picked up.',
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
      `I want to say upfront that ${row.fair_observation}`,
      `What stood out, though, was ${row.main_finding}`,
      `That meant ${row.commercial_consequence}`,
      ADDITIONAL_FINDINGS_HOOK_LINE,
      "I've put together a personalised breakdown of what we found. Happy to send it over if you'd like to see it.",
      'Joe',
    ].join('\n\n'));
    ok('the normal structure assembles exactly as locked: intro, "I want to say upfront that" fair observation, "What stood out, though, was" main finding, "That meant" consequence, the additional-findings tease, the locked CTA, sign-off');
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

  // ── The locked final two paragraphs are ALWAYS both there ──
  {
    for (const [why, row] of [
      ['nothing beyond the primary narrative', fullRow({ additional_findings_hook: '' })],
      ['a stored hook someone blanked', fullRow({ additional_findings_hook: '' })],
      ['a stored hook someone rewrote', fullRow({ additional_findings_hook: 'We noticed four other problems with your process.' })],
      ['the no-response variant', noResponseRow()],
    ]) {
      const body = assembleEmail(row);
      assert.ok(body.includes(`\n\n${ADDITIONAL_FINDINGS_HOOK_LINE}\n\n${CTA_LINE}\n\n${SIGN_OFF}`),
        `${why}: the locked transition and the locked CTA both close the email, in that order`);
      assert.ok(!body.includes('four other problems'), `${why}: a stored hook is never printed as copy`);
    }
    ok('the final two paragraphs are locked and appear in every sendable email, in both variants — the transition is not conditional on a leftover finding, and the stored additional_findings_hook is never used as copy');
  }

  // ── Only the truly optional paragraphs are optional ──
  {
    const minimal = assembleEmail(fullRow({ wider_observation: '', wider_consequence: '' }));
    const row = fullRow();
    assert.strictEqual(minimal, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 18 August about 14 Oak Road.',
      `I want to say upfront that ${row.fair_observation}`,
      `What stood out, though, was ${row.main_finding}`,
      `That meant ${row.commercial_consequence}`,
      ADDITIONAL_FINDINGS_HOOK_LINE,
      CTA_LINE,
      'Joe',
    ].join('\n\n'));
    assert.ok(!/\n\n\n/.test(minimal), 'no blank gap is left where the wider beat would have been');
    ok('the wider beat is dropped entirely when empty — the email closes up rather than showing a gap');
  }

  // ── The wider beat: the observation, then its separate consequence ──
  {
    const body = assembleEmail(fullRow({
      commercial_consequence: 'the enquiry was getting attention, but it was not really being progressed.',
      wider_observation: "I'd also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation.",
      wider_consequence: 'a potential seller instruction sitting inside the same enquiry was never explored.',
    }));
    assert.ok(body.indexOf(THAT_MEANT_PREFIX) < body.indexOf("I'd also mentioned"), 'the wider observation follows the first consequence');
    assert.ok(body.indexOf("I'd also mentioned") < body.indexOf(THAT_ALSO_MEANT_PREFIX), 'and its own consequence follows it');
    assert.ok(body.includes("\n\nI'd also mentioned that I had a property of my own that I was considering selling, but that never really came into the conversation.\n\n"),
      'the observation stands as its own paragraph, exactly as written');
    assert.ok(body.includes('\n\nThat also meant a potential seller instruction sitting inside the same enquiry was never explored.\n\n'),
      'and the wider consequence is opened by the fixed wording this layer owns');
    assert.ok(body.indexOf(THAT_ALSO_MEANT_PREFIX) < body.indexOf(ADDITIONAL_FINDINGS_HOOK_LINE), 'both sit before the curiosity line');

    // The observation can stand alone; the consequence cannot.
    const observationOnly = assembleEmail(fullRow({ wider_observation: 'I had a property of my own to sell too.', wider_consequence: '' }));
    assert.ok(observationOnly.includes('\n\nI had a property of my own to sell too.\n\n'));
    assert.ok(!observationOnly.includes(THAT_ALSO_MEANT_PREFIX), 'no wider consequence, no "That also meant" paragraph');

    // An ORPHAN wider consequence is the consequence of something the reader
    // was never told, so it is dropped rather than printed.
    for (const variant of ['normal', 'no_response']) {
      const row = variant === 'normal'
        ? fullRow({ wider_observation: '', wider_consequence: 'the valuation inside the same enquiry was never explored.' })
        : noResponseRow({ wider_observation: '', wider_consequence: 'the valuation inside the same enquiry was never explored.' });
      const orphan = assembleEmail(row);
      assert.ok(!orphan.includes(THAT_ALSO_MEANT_PREFIX), `${variant}: "That also meant" needs an observation in front of it`);
      assert.ok(!orphan.includes('never explored'), `${variant}: and the orphan consequence is not printed at all`);
    }
    ok('the wider beat is a PAIR — the observation can stand alone, but "That also meant" never prints without the observation it is the consequence of');
  }

  // ── A fixed prefix is never printed twice ──
  {
    const doubled = assembleEmail(fullRow({
      wider_observation: 'I had a property of my own to sell too.',
      fair_observation: 'I want to say upfront that you got back to me quickly.',
      main_finding: 'What stood out, though, was that nobody asked my timescale.',
      commercial_consequence: 'That meant the valuation was never offered.',
      wider_consequence: 'That also meant the seller side went unexplored.',
    }));
    for (const prefix of [FAIR_OBSERVATION_PREFIX, MAIN_FINDING_PREFIX, THAT_MEANT_PREFIX, THAT_ALSO_MEANT_PREFIX]) {
      assert.strictEqual((doubled.match(new RegExp(prefix.trim(), 'g')) || []).length, 1,
        `"${prefix.trim()}" appears exactly once even though the stored field already carried it`);
    }
    assert.strictEqual(withPrefix(THAT_MEANT_PREFIX, 'the lead went cold.'), 'That meant the lead went cold.');
    assert.strictEqual(withPrefix(THAT_MEANT_PREFIX, 'That meant the lead went cold.'), 'That meant the lead went cold.');
    assert.strictEqual(withPrefix(THAT_MEANT_PREFIX, ''), '', 'an empty continuation produces no paragraph at all');
    ok('withPrefix joins the fixed opener to the continuation and never stutters, so a stored row written before a prefix moved into this layer still reads correctly');
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
    assert.ok(body.includes('\n\nI want to say upfront that you came back fast\n\n'), 'the fair observation is passed through byte-for-byte after the fixed opener');
    assert.ok(body.includes('\n\nWhat stood out, though, was each follow-up asked me to chase\n\n'), 'and so is the main finding');
    ok('the assembler adds the fixed opener and nothing else — it never repairs, capitalises or punctuates a sentence, because sentence-ready copy is Personalisation\'s contract');
  }

  // ── VARIANT 1: the no-response structure ──
  {
    const body = assembleEmail(noResponseRow());
    const row = noResponseRow();
    assert.strictEqual(body, [
      'Hi {{first_name}},',
      'We sent your team an enquiry on 18 August about 14 Oak Road.',
      'We never received a reply.',
      `That meant ${row.commercial_consequence}`,
      row.wider_observation,
      `That also meant ${row.wider_consequence}`,
      ADDITIONAL_FINDINGS_HOOK_LINE,
      CTA_LINE,
      'Joe',
    ].join('\n\n'));
    ok('the no-response structure assembles as its own fixed shape: the plain no-reply line, the consequence, the optional wider beat, and then the same locked closing two paragraphs as every other email');
  }

  // ── The no-response case never describes a conversation ──
  {
    const body = assembleEmail(noResponseRow({
      // A row that (wrongly) still carries normal-case copy must not print it.
      fair_observation: 'You came back to me quickly.',
      main_finding: 'The reply did not mention the property.',
    }));
    assert.ok(!body.includes('You came back to me quickly.'), 'a stray fair observation is not printed');
    assert.ok(!body.includes(FAIR_OBSERVATION_PREFIX), 'and neither is its fixed opener — there was no interaction to praise');
    assert.ok(!body.includes('The reply did not mention the property.'), 'nor a stray main finding — there was no reply to describe');
    assert.ok(body.includes(NO_REPLY_LINE), 'the fixed no-reply line stands in their place');
    assert.ok(body.includes(ADDITIONAL_FINDINGS_HOOK_LINE) && body.includes(CTA_LINE), 'and the same locked closing is used as in a normal email');
    assert.strictEqual((body.match(/couple of/g) || []).length, 1, 'so "a couple of other things" is offered exactly once');
    ok('the no-response structure prints only what is true of silence — no conversation, no invented praise — and closes with exactly the same locked two paragraphs');
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

  // ── THE SENDABILITY CONTRACT, enforced in code ──
  {
    for (const [why, row, expected] of [
      ['no property address', fullRow({ property_address: '' }), 'missing_property_address'],
      ['no enquiry date', fullRow({ enquiry_date: '' }), 'missing_enquiry_date'],
      ['no commercial consequence', fullRow({ commercial_consequence: '' }), 'missing_commercial_consequence'],
      ['no main finding in the normal structure', fullRow({ main_finding: '' }), 'missing_main_finding'],
      ['no fair observation in the normal structure', fullRow({ fair_observation: '' }), 'missing_fair_observation'],
      ['no commercial consequence in the no-response structure', noResponseRow({ commercial_consequence: '' }), 'missing_commercial_consequence'],
    ]) {
      assert.strictEqual(isSendable(row), false, `${why}: not sendable`);
      assert.ok(emailContractViolations(row).includes(expected), `${why}: the violation is named as ${expected}`);
      assert.strictEqual(assembleEmail(row), '', `${why}: assembles nothing at all`);
    }

    // A probe with human contact and no fair observation is the case the
    // brief calls out by name: it fails validation rather than quietly
    // sending a shorter email that opens on the criticism.
    assert.deepStrictEqual(emailContractViolations(fullRow()), [], 'a complete normal row has no violations');
    assert.deepStrictEqual(emailContractViolations(noResponseRow()), [], 'and neither does a complete no-response row');

    // The no-response structure needs neither of the two — that is the point.
    assert.strictEqual(isSendable(noResponseRow({ main_finding: '', fair_observation: '' })), true,
      'the no-response structure needs no fair observation and no main finding');
    assert.ok(assembleEmail(noResponseRow({ main_finding: '', fair_observation: '' })), 'and still assembles');
    assert.strictEqual(assembleEmail(null), '', 'a missing row assembles nothing');
    assert.strictEqual(assembleEmail({}), '', 'and so does an empty one');
    ok('a normal email needs fair_observation, main_finding AND commercial_consequence — a row missing any of them is not sendable, names the violation, and assembles nothing at all rather than an email with a hole in it');
  }

  // ── An unrecognised variant is a normal email, never a silent reshape ──
  {
    assert.strictEqual(normaliseVariant('no_response'), 'no_response');
    assert.strictEqual(normaliseVariant('normal'), 'normal');
    assert.strictEqual(normaliseVariant(''), 'normal');
    assert.strictEqual(normaliseVariant(undefined), 'normal');
    assert.strictEqual(normaliseVariant('NO_RESPONSE'), 'normal', 'only the exact marker switches structure');
    assert.ok(assembleEmail(fullRow({ email_variant: 'something_else' })).includes(`${MAIN_FINDING_PREFIX}${fullRow().main_finding}`),
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
