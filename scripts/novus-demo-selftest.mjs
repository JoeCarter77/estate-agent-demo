// scripts/novus-demo-selftest.mjs — hermetic end-to-end test (no network, no
// creds, no AI) for the personalised demo, the LAST STEP of the pipeline:
//
//   PROBE -> COMMUNICATIONS -> INTELLIGENCE -> DIAGNOSIS ->
//   DIAGNOSIS_FINDINGS -> PERSONALISATION -> DEMOS
//     -> GET /api/demo?slug=...  ->  render-ready payload
//
// It runs the REAL api/demo.js handler and the REAL lib/demo-compile.mjs step
// over an in-memory workbook seeded with live-shaped headers, and proves the
// things that would otherwise only fail in front of a prospect:
//
//   A. property-image extraction is pure, picks the LARGEST listing photo,
//      rejects logos/floorplans/EPCs, and returns '' for a blocked page
//   B. one weak_seller_qualification probe compiles a complete DEMOS row
//   C. an unsupported hero_journey is REFUSED, not fudged into another shape
//   D. ready vs needs_review, and exactly what tips it either way
//   E. the slug is deterministic, and a second probe never steals another's
//   F. GET by slug returns render-ready JSON with no pipeline keys in it
//   G. a view increments telemetry; ?preview=1 does not; archived is gone
//   H. the CTA records once — a reload is not a second signal
//   I. a recompile preserves identity, created_at and EVERY analytics field
//   J. the demo write path is authed; the read path is not
//   K. …and the recovery-build/archive/restore edge cases, including that a
//      needs_review demo 404s exactly like an unknown slug for a normal
//      request, resolves only under ?preview=1, and stays gone under preview
//      when archived
//   L. AUTOMATIC COMPILATION: a probe that finishes PERSONALISATION comes out
//      of the same pass with a live demo, and the pass self-heals a probe that
//      was personalised before the DEMOS tab existed
//   M. THE PROSPECT PATH READS ONE TAB. GET touches DEMOS and nothing else.
//   N. OBSERVED-EVENTS EVIDENCE: the events shown are drawn from the probe's
//      matched COMMUNICATIONS rows by fixed rules — never an AI call — and
//      fall back to the old INTELLIGENCE-only summary when none are matched
//   O. display formatting
//
// Run: npm run novus:demo-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import demoHandler from '../api/demo.js';
import {
  ANALYTICS_COLUMNS, DEMOS_HEADER, buildDemoRow, buildDemoSlug, buildObservedEvents, stripUnsafeSellerValue,
  formatResponseTime, formatChannels, normaliseDashes, reviewReasonsFor,
  selectCommunicationEvidence, sellerDeclarationSummary,
  sentenceCase, statusFromReasons, toRenderReady,
} from '../lib/demos.mjs';
import { compileDemos, compileDecision } from '../lib/demo-compile.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { extractPropertyImageUrl, fetchPropertyImageUrl, isUsablePropertyImage } from '../lib/property-image.mjs';
import { journeySupport, SUPPORTED_HERO_JOURNEYS } from '../lib/demo-journeys.mjs';

// ── live-shaped headers ──────────────────────────────────────────────────────
const PROBES_HEADER = [
  'probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address', 'property_url',
  'property_price', 'property_status', 'enquiry_text', 'probe_email', 'probe_phone',
  'probe_timestamp', 'observation_deadline', 'probe_status', 'created_at', 'updated_at',
];
const AGENCIES_HEADER = ['agency_id', 'agency_name', 'website', 'domain', 'location'];
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'observation_status', 'human_contact',
  'response_hours', 'first_human_response_at', 'contact_attempts', 'follow_ups',
  'channels_used', 'viewing_progression', 'buyer_qualification', 'buyer_questions_asked',
  'seller_recognition', 'communication_quality', 'did_well', 'missed', 'evidence',
  'grade', 'grade_reason',
];
// runRebuildPass reads COMMUNICATIONS too — Part L needs the tab to exist even
// though this probe's INTELLIGENCE is already seeded and nothing re-derives it.
const COMMUNICATIONS_HEADER = [
  'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'channel', 'direction',
  'source_identifier_normalized', 'subject', 'body_text', 'transcript', 'raw_content',
  // Live-shaped: the demo's FIRST RESPONSE beat reads this to tell an
  // unanswered call from an answered one, so the fixture has to carry it.
  'voicemail_present',
  'match_status', 'automated_or_human', 'manual_override', 'created_at', 'updated_at',
];
const DIAGNOSIS_HEADER = [
  'diagnosis_id', 'probe_id', 'agency_id', 'strengths', 'missed_opportunities',
  'commercial_implication', 'novus_opportunity', 'diagnosis_summary', 'created_at', 'updated_at',
];
const DIAGNOSIS_FINDINGS_HEADER = ['probe_id', 'finding_index', 'finding_type', 'finding', 'evidence', 'significance_note'];
const PERSONALISATION_HEADER = [
  'personalisation_id', 'agency_id', 'probe_id', 'hero_journey', 'primary_narrative',
  'narrative_finding_indexes', 'positive_finding_index', 'main_finding_index',
  'wider_finding_index', 'supporting_findings', 'evidence', 'novus_counterfactual',
  'enquiry_date', 'property_address', 'email_variant', 'fair_observation', 'main_finding',
  'commercial_consequence', 'wider_observation', 'wider_consequence',
  'additional_findings_hook', 'email_body', 'created_at', 'updated_at',
];

const SELLER_DECLARATION =
  'Interested in viewing this property. Also declared: has a property to sell — it is not yet on the market.';

function row(header, obj) { return header.map((k) => obj[k] ?? ''); }

// The same in-memory Sheets transport every other NOVUS self-test uses.
function makeWorkbook(seed = {}) {
  const store = {
    PROBES: [PROBES_HEADER.slice(), row(PROBES_HEADER, { probe_id: 'SCHEMA NOTE' })],
    AGENCIES: [AGENCIES_HEADER.slice()],
    // Always present, like every other required tab here — COMMUNICATIONS is
    // one of the pipeline's original five tabs and is never optional in the
    // live workbook. compileDemos() now reads it (§ evidence selection), so
    // it has to exist by default the same way PROBES/AGENCIES/INTELLIGENCE do.
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice()],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    DIAGNOSIS_FINDINGS: [DIAGNOSIS_FINDINGS_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    DEMOS: [DEMOS_HEADER.slice(), row(DEMOS_HEADER, { demo_slug: 'SCHEMA NOTE' })],
    ...seed,
  };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  // Every tab this workbook is asked for, in order. Part M reads it to prove
  // the prospect's request touches DEMOS and nothing else.
  const reads = [];
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
      reads.push(tab);
      if (!(tab in store)) throw new Error(`Sheets API GET ${tab} failed (400): Unable to parse range`);
      return store[tab].map((r) => r.slice());
    },
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
        while (store[tab].length < start - 1) store[tab].push([]);
        values.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      }
    },
  };
  return { store, reads, repo: createRepo(valuesApi) };
}

function demoRowsOf(store) {
  return store.DEMOS.slice(1)
    .filter((r) => r[0] && r[1] && r[1] !== 'SCHEMA NOTE')
    .map((r) => Object.fromEntries(DEMOS_HEADER.map((k, i) => [k, r[i] ?? ''])));
}

const BASIC = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
const mockReq = ({ method = 'POST', body = {}, query = {}, auth = true } = {}) => ({
  method, body, query, headers: auth ? { authorization: BASIC } : {},
});
const mockRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  end() { return this; },
  setHeader(k, v) { this.headers[k] = v; },
});

let passed = 0;
const ok = (msg) => { passed += 1; console.log('  ✓ ' + msg); };

// ── the fixture: one real-shaped weak_seller_qualification probe ─────────────
function seedWeakSeller(store, {
  probeId = 'prb_demo_001',
  probeReference = 'RM-0042',
  agencyId = 'agc_demo',
  agencyName = 'Ensum Brown',
  heroJourney = 'weak_seller_qualification',
  // Blank it where a test runs the FULL pass: runRebuildPass compiles demos
  // itself, and a probe with no listing URL is the only way to keep that path
  // hermetic without threading a test seam through the whole pipeline.
  propertyUrl = 'https://www.rightmove.co.uk/properties/123456789',
} = {}) {
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: probeId,
    probe_reference: probeReference,
    agency_id: agencyId,
    portal: 'rightmove',
    property_address: 'Barn Field, Chevington (2 bed semi, £375,000)',
    property_url: propertyUrl,
    property_price: '£375,000',
    property_status: 'for_sale',
    enquiry_text: SELLER_DECLARATION,
    probe_timestamp: '2026-08-17T22:34:41.000Z',
    probe_status: 'sent',
  }));
  store.AGENCIES.push(row(AGENCIES_HEADER, { agency_id: agencyId, agency_name: agencyName }));
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_demo_001',
    agency_id: agencyId,
    probe_id: probeId,
    observation_status: 'closed',
    human_contact: 'yes',
    response_hours: '0.38',
    first_human_response_at: '2026-08-17T22:57:41.000Z',
    contact_attempts: '3',
    follow_ups: '2',
    channels_used: 'voice,email',
    viewing_progression: 'slot_offered',
    buyer_qualification: 'standard',
    seller_recognition: 'asked_position',
    communication_quality: 'strong',
    grade: 'B',
  }));
  // Three real contact attempts (30-minute grouping), matching the
  // INTELLIGENCE row above: a voicemail + email inside 23 minutes of the
  // enquiry, then two later follow-ups — the real evidence
  // selectCommunicationEvidence() now reads instead of the old generic counts.
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_demo_001', agency_id: agencyId, probe_id: probeId,
    occurred_at: '2026-08-17T22:57:41.000Z', channel: 'voice', direction: 'outbound',
    voicemail_present: 'TRUE', automated_or_human: 'human',
    transcript: "Hi, it's Rosa from Ensum Brown, calling about Barn Field. Give us a call back.",
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_demo_002', agency_id: agencyId, probe_id: probeId,
    occurred_at: '2026-08-17T22:58:56.000Z', channel: 'email', direction: 'outbound',
    automated_or_human: 'human', subject: 'Barn Field, Chevington',
    body_text: 'Hi Priya, thanks for your enquiry about Barn Field. Are you on the market or renting for example?',
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_demo_003', agency_id: agencyId, probe_id: probeId,
    occurred_at: '2026-08-18T09:15:00.000Z', channel: 'email', direction: 'outbound',
    automated_or_human: 'human',
    body_text: "Just checking back in — are Saturday or Sunday still good for the viewing?",
  }));
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_demo_004', agency_id: agencyId, probe_id: probeId,
    occurred_at: '2026-08-18T09:50:00.000Z', channel: 'voice', direction: 'outbound',
    automated_or_human: 'human',
    transcript: "Hi it's Rosa again — wanted to see if Saturday or Sunday still works for the viewing.",
  }));
  store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
    probe_id: probeId,
    finding_index: '1',
    finding_type: 'opportunity',
    finding: 'The declared property to sell was asked about once and never converted into a valuation.',
    evidence: '"Are you on the market or renting for example?" (email, 22:57) — no valuation offered in any message.',
    significance_note: 'An instruction lead was recognised in words and left on the table.',
  }));
  store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
    probe_id: probeId,
    finding_index: '2',
    finding_type: 'positive',
    finding: 'The team followed up quickly across two channels.',
    evidence: 'Voicemail and email inside 23 minutes, then a chase the next morning.',
    significance_note: 'Shows genuine persistence on the buying side.',
  }));
  store.PERSONALISATION.push(row(PERSONALISATION_HEADER, {
    personalisation_id: 'psn_demo_001',
    agency_id: agencyId,
    probe_id: probeId,
    hero_journey: heroJourney,
    primary_narrative: 'Fast, capable handling of the viewing; the declared sale never became a valuation.',
    novus_counterfactual: 'NOVUS would have answered the viewing and offered a market appraisal in the same reply.',
    enquiry_date: '17 August',
    property_address: 'Barn Field, Chevington',
    email_variant: 'normal',
    fair_observation: 'you came back inside 23 minutes and followed up twice more across phone and email.',
    main_finding: 'the property I said I had to sell was asked about once and never taken any further.',
    commercial_consequence: 'a valuation that was already inside the enquiry was never booked, and the instruction behind it never entered your pipeline.',
    email_body: 'Hi {{first_name}}, ...',
  }));
}

// A probe that is closed, interpreted and DIAGNOSED but not yet personalised
// — the exact state lib/rebuild-pass.mjs hands to the personalisation step, so
// Part L exercises the real "PERSONALISATION completes -> demo appears" edge
// rather than a shortcut.
function seedPipelineReadyProbe(store, { probeId = 'prb_auto_001' } = {}) {
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: probeId,
    probe_reference: 'RM-0099',
    agency_id: 'agc_auto',
    portal: 'rightmove',
    property_address: 'Willow Lane, Hartwell',
    property_url: '',                                  // no listing: no image fetch, no network
    property_price: '£420,000',
    property_status: 'for_sale',
    enquiry_text: SELLER_DECLARATION,
    probe_timestamp: '2026-08-10T18:52:00.000Z',
    probe_status: 'sent',
  }));
  store.AGENCIES.push(row(AGENCIES_HEADER, { agency_id: 'agc_auto', agency_name: 'Auto Agency' }));
  store.INTELLIGENCE.push(row(INTELLIGENCE_HEADER, {
    intelligence_id: 'itl_auto_001',
    agency_id: 'agc_auto',
    probe_id: probeId,
    observation_status: 'closed',
    human_contact: 'yes',
    response_hours: '0.5',
    first_human_response_at: '2026-08-10T19:22:00.000Z',
    contact_attempts: '2',
    follow_ups: '1',
    channels_used: 'email',
    viewing_progression: 'slot_offered',
    buyer_qualification: 'standard',
    buyer_questions_asked: 'viewing availability',
    seller_recognition: 'asked_position',
    communication_quality: 'competent',
    did_well: 'Answered quickly and offered a slot.',
    missed: 'Never offered a valuation.',
    evidence: '"Are you on the market?"',
    grade: 'B',
    grade_reason: 'Fast first response with follow-up.',
  }));
  // DIAGNOSIS finalised (non-blank diagnosis_summary) is the gate the
  // personalisation step opens on.
  store.DIAGNOSIS.push(row(DIAGNOSIS_HEADER, {
    diagnosis_id: 'dgn_auto_001',
    probe_id: probeId,
    agency_id: 'agc_auto',
    strengths: 'Quick, clear reply that offered a viewing slot.',
    missed_opportunities: 'The declared property to sell never became a valuation.',
    commercial_implication: 'An instruction inside a £420,000 enquiry was left on the table.',
    novus_opportunity: 'Growth (valuation list / seller conversion)',
    diagnosis_summary: 'Fast on the buyer, silent on the seller.',
  }));
  store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
    probe_id: probeId,
    finding_index: '1',
    finding_type: 'opportunity',
    finding: 'The declared property to sell was asked about and never converted into a valuation.',
    evidence: '"Are you on the market?" — no valuation offered in any message.',
    significance_note: 'An instruction lead was recognised and left on the table.',
  }));
  store.DIAGNOSIS_FINDINGS.push(row(DIAGNOSIS_FINDINGS_HEADER, {
    probe_id: probeId,
    finding_index: '2',
    finding_type: 'positive',
    finding: 'The team replied within half an hour and offered a slot.',
    evidence: 'First human reply 30 minutes after the enquiry.',
    significance_note: 'Genuinely fast on the buying side.',
  }));
  // Matches first_human_response_at above — so the demo this pass compiles
  // also exercises the real evidence path (selectCommunicationEvidence),
  // not just the AI-derived personalisation copy.
  store.COMMUNICATIONS.push(row(COMMUNICATIONS_HEADER, {
    communication_id: 'com_auto_001', agency_id: 'agc_auto', probe_id: probeId,
    occurred_at: '2026-08-10T19:22:00.000Z', channel: 'email', direction: 'outbound',
    automated_or_human: 'human', subject: 'Willow Lane, Hartwell',
    body_text: 'Hi, thanks for your enquiry about Willow Lane — Saturday or Sunday for a viewing?',
  }));
}

// HERMETIC BY CONSTRUCTION. Nothing in this suite may reach a portal, so every
// compile goes through a stub in place of the one listing fetch. `never` is
// the "Rightmove blocked us" answer, which is the interesting case anyway.
const noImage = async () => '';
const anImage = async () => 'https://media.rightmove.co.uk/dir/1/IMG_01_0000_max_656x437.jpeg';

// The one AI call Part L's pass makes. Everything else on that probe is
// already seeded, so this fake only has to answer the personalisation tool —
// and it THROWS for any other tool name, which is what proves the DEMOS
// compile step that runs immediately afterwards makes no AI call of its own:
// if it did, this fake would blow up the pass rather than silently pass.
let personalisationAiCalls = 0;
async function fakePersonalisationAi({ tool }) {
  personalisationAiCalls += 1;
  if (tool?.name !== 'record_probe_personalisation') {
    throw new Error(`Part L should only need the personalisation call, got "${tool?.name}"`);
  }
  return {
    story_reasoning: 'The viewing moved; the declared sale did not.',
    primary_narrative: 'A fast, capable reply on the buying side, with the declared sale never taken further.',
    positive_finding_index: 2,
    main_finding_index: 1,
    wider_finding_index: null,
    supporting_findings: '',
    fair_observation: 'you replied within half an hour and put a viewing slot on the table.',
    main_finding: 'the property I said I had to sell was asked about once and never taken any further.',
    commercial_consequence: 'a valuation that was already inside the enquiry was never booked, and the instruction behind it never reached your pipeline.',
    wider_observation: '',
    wider_consequence: '',
    novus_counterfactual: 'NOVUS would have answered the viewing and offered a market appraisal in the same reply.',
  };
}

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';

  // ══ Part A — property image extraction (pure, no network) ═════════════════
  console.log('\nPart A — property image extraction');
  {
    // Rightmove's real shape: PAGE_MODEL with an images[] carrying both a
    // canonical url and a resizedImageUrls map.
    const rightmoveHtml = `<!doctype html><html><head>
      <meta property="og:image" content="https://media.rightmove.co.uk/brand/logo_max_100x100.png" />
      </head><body><script>window.PAGE_MODEL = {"propertyData":{"id":123,"images":[
        {"url":"https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_476x358.jpeg",
         "resizedImageUrls":{"size135x100":"https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_135x100.jpeg","size656x437":"https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_656x437.jpeg"}},
        {"url":"https://media.rightmove.co.uk/dir/123/IMG_02_0000_max_476x358.jpeg"}]}}</script></body></html>`;
    const extracted = extractPropertyImageUrl(rightmoveHtml);
    assert.strictEqual(extracted, 'https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_656x437.jpeg');
    ok('picks the FIRST listing photo at its LARGEST published size');
    assert.ok(!extracted.includes('logo'), 'the brand logo in og:image must never win');
    ok('the branch logo in og:image never beats the property media array');
  }
  {
    // A challenge/blocked page carries no listing media at all.
    assert.strictEqual(extractPropertyImageUrl('<html><body>Please verify you are human</body></html>'), '');
    assert.strictEqual(extractPropertyImageUrl(''), '');
    ok('a blocked or empty page extracts to "" (never a throw, never a guess)');
  }
  {
    assert.strictEqual(isUsablePropertyImage('https://media.rightmove.co.uk/x/IMG_01_FLP_00.jpeg'), false);
    assert.strictEqual(isUsablePropertyImage('https://media.rightmove.co.uk/x/prop_epcgraph.png'), false);
    assert.strictEqual(isUsablePropertyImage('/relative/photo.jpg'), false);
    assert.strictEqual(isUsablePropertyImage('https://media.rightmove.co.uk/x/IMG_01.jpeg'), true);
    ok('floorplans, EPC graphs and relative paths are rejected as hero images');
  }
  {
    // og:image is the correct answer for a non-Rightmove listing.
    const generic = '<html><head><meta property="og:image" content="https://cdn.example.com/houses/hero.jpg"></head></html>';
    assert.strictEqual(extractPropertyImageUrl(generic), 'https://cdn.example.com/houses/hero.jpg');
    ok('a non-portal listing falls back to og:image');
  }
  {
    // Every network failure mode resolves to '' rather than throwing.
    const blocked = await fetchPropertyImageUrl('https://www.rightmove.co.uk/properties/1', {
      fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => 'text/html' }, text: async () => '' }),
    });
    assert.strictEqual(blocked, '');
    const exploded = await fetchPropertyImageUrl('https://www.rightmove.co.uk/properties/1', {
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    assert.strictEqual(exploded, '');
    assert.strictEqual(await fetchPropertyImageUrl(''), '');
    ok('a 403, a network error and a blank URL all resolve to "" (image never blocks a build)');
  }

  // ══ Part B — the row builder ══════════════════════════════════════════════
  console.log('\nPart B — compiling a weak_seller_qualification DEMOS row');
  let builtRow;
  {
    const { store } = makeWorkbook();
    seedWeakSeller(store);
    const probe = Object.fromEntries(PROBES_HEADER.map((k, i) => [k, store.PROBES[2][i] ?? '']));
    const agency = Object.fromEntries(AGENCIES_HEADER.map((k, i) => [k, store.AGENCIES[1][i] ?? '']));
    const intelligence = Object.fromEntries(INTELLIGENCE_HEADER.map((k, i) => [k, store.INTELLIGENCE[1][i] ?? '']));
    const personalisation = Object.fromEntries(PERSONALISATION_HEADER.map((k, i) => [k, store.PERSONALISATION[1][i] ?? '']));
    const communications = store.COMMUNICATIONS.slice(1)
      .map((r) => Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, r[i] ?? ''])));
    const findings = [
      { finding_index: 1, finding_type: 'opportunity', finding: 'The declared property to sell was asked about once and never converted into a valuation.', evidence: 'no valuation offered in any message', significance_note: 'An instruction lead was recognised in words and left on the table.' },
      { finding_index: 2, finding_type: 'positive', finding: 'The team followed up quickly across two channels.', evidence: 'Voicemail and email inside 23 minutes', significance_note: 'Shows genuine persistence.' },
    ];

    const { row: built, reasons, status } = buildDemoRow({
      probe, agency, intelligence, findings, personalisation, communications,
      propertyImageUrl: 'https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_656x437.jpeg',
      propertyImageStatus: 'ok',
      now: '2026-08-24T10:00:00.000Z',
    });
    builtRow = built;

    assert.strictEqual(built.hero_journey, 'weak_seller_qualification');
    assert.strictEqual(built.agency_name, 'Ensum Brown');
    // The analyst's bracketed note (which carries a stray price) is stripped.
    assert.strictEqual(built.property_address, 'Barn Field, Chevington');
    ok('property_address drops the analyst note, exactly as the email does');

    assert.strictEqual(built.enquiry_date, '17 August');
    assert.strictEqual(built.enquiry_time, '23:34'); // 22:34 UTC is 23:34 in Europe/London
    ok('enquiry date and time are the ones the agency would recognise (Europe/London)');

    assert.strictEqual(built.seller_declared, 'yes');
    assert.strictEqual(built.response_time, '23 minutes');
    ok('response_hours 0.38 renders as "23 minutes"');

    // THE FIRST FIVE SECONDS. The opening names what the team genuinely did
    // (3 attempts, a slot offered) AND the opportunity nobody worked — both
    // derived from this probe's own INTELLIGENCE ordinals.
    assert.strictEqual(
      built.demo_hook,
      'A buyer enquiry - and a potential seller your process could have identified and progressed.',
    );
    assert.ok(!/missed instruction/i.test(built.demo_hook), 'a declared vendor is never a definite missed instruction');
    assert.strictEqual(built.demo_reveal, "The buyer was worked. The potential vendor wasn't.");
    ok('the opening names both opportunities inside the one enquiry');

    // HOUSE STYLE: no em or en dash reaches the page, from authored copy or
    // from PERSONALISATION's own sentences.
    const prospectCopy = [
      built.demo_hook, built.positive_observation, built.demo_reveal, built.main_finding,
      built.commercial_consequence, built.systemic_bridge, built.cta_headline,
      built.observed_events_json, built.novus_detected_json, built.novus_decisions_json,
      built.novus_actions_json,
    ].join(' ');
    assert.ok(!/[\u2014\u2013]/.test(prospectCopy), 'no em or en dashes anywhere in the compiled copy');
    ok('every prospect-facing string on the row uses the small hyphen only');

    // Prospect-facing copy comes from PERSONALISATION, raised to a sentence —
    // never rewritten.
    assert.ok(built.positive_observation.startsWith('You came back inside 23 minutes'));
    assert.ok(built.commercial_consequence.startsWith('A valuation that was already inside'));
    ok('positive observation and consequence are PERSONALISATION copy, sentence-cased only');

    const events = JSON.parse(built.observed_events_json);
    const metrics = events.filter((e) => e.kind === 'metric');
    const artefacts = events.filter((e) => e.kind === 'evidence');

    // THE QUANTIFIED SUMMARY — read in about three seconds, every line a fact
    // this probe's own INTELLIGENCE row establishes.
    assert.deepStrictEqual(metrics.map((m) => m.label), [
      '2 opportunities',
      '3 contact attempts',
      'Viewing slot offered',
      'Seller position asked about, never taken further',
      'No valuation progression',
    ]);
    assert.strictEqual(metrics[1].detail, 'phone and email');
    assert.deepStrictEqual(metrics.map((m) => m.tone), ['neutral', 'good', 'good', 'gap', 'gap']);
    ok('the evidence is a compact metric strip: what happened, and the two things that did not');

    // THE MINIMUM REAL PROOF — the declaration as submitted, and ONE actual
    // message. Two more quotes proved nothing the first did not.
    assert.strictEqual(artefacts.length, 3, `beat 2 tells the story in three beats, got ${artefacts.length}`);
    assert.deepStrictEqual(artefacts.map((a) => a.label), [
      'Enquiry sent about this property',
      'First response',
      'Other contact attempts',
    ]);
    // What the buyer declared, INCLUDING that the property was pre-market.
    assert.strictEqual(
      artefacts[0].detail,
      'Buyer declared they also had a property to sell, and that it was not yet on the market.',
    );
    // The first touch was an unanswered call, so that is all it says.
    assert.strictEqual(artefacts[1].detail, 'Voicemail left.');
    // Everything after it, summarised from the real attempts and the two
    // INTELLIGENCE ordinals — never a second and third quote.
    assert.strictEqual(
      artefacts[2].detail,
      '2 further contact attempts were made by email and phone, focused on progressing the viewing.'
      + ' The seller position was asked about once and never taken any further.',
    );
    assert.ok(!events.some((e) => e.label === 'Enquiry submitted'), 'the enquiry timestamp is on the property card, not repeated as a row');
    ok('beat 2 reads as a chronology: what was declared, what came back, what followed');

    const detected = JSON.parse(built.novus_detected_json);
    const decisions = JSON.parse(built.novus_decisions_json);
    const actions = JSON.parse(built.novus_actions_json);
    // UNDERSTAND -> DECIDE -> ACT stays the visual signature. Each stage is now
    // ONE line, because the claim being made is that NOVUS comprehends the
    // commercial context, chooses, and then executes - not that it sends
    // messages. A second bullet per stage reads as a feature list and pulls the
    // section back towards "chatbot".
    assert.deepStrictEqual(detected.map((d) => d.label), ['Recognises both sides of the enquiry']);
    assert.deepStrictEqual(decisions.map((d) => d.label), ['Chooses the right next action for each opportunity']);
    assert.deepStrictEqual(actions.map((a) => a.label), ['Carries out the next step - or brings your team in']);
    ok('UNDERSTANDS / DECIDES / ACTS is one claim per stage, not a feature list');

    // UNDERSTANDS names both opportunities AND the gap - comprehension, not
    // detection. The seller half is only asserted because this probe declared one.
    assert.strictEqual(
      detected[0].detail,
      'Understands the buyer opportunity, the declared seller opportunity, and what information is still missing.',
    );
    // DECIDES has to show a CHOICE being made across a wider set of actions than
    // this one enquiry needed, or it reads as "always books a viewing".
    ['viewing progression', 'seller qualification', 'valuation', 'follow-up', 'escalation'].forEach((option) => {
      assert.ok(decisions[0].detail.includes(option), `DECIDES must show ${option} as one of the options weighed`);
    });
    // ACTS is execution AND routing in one line, so it carries no owner chip:
    // choosing between the two is the capability being described.
    assert.ok(actions.every((a) => !a.owner), 'ACTS is one line covering both paths, so no stage is labelled NOVUS or Your team');
    assert.ok(
      actions[0].detail.includes('automatically') && actions[0].detail.includes('routes the opportunity to the team'),
      'ACTS must say NOVUS executes where it should and routes where a person is needed',
    );
    ok('beat 3 reads as understands commercial context -> decides -> executes or routes');

    assert.strictEqual(
      built.cta_headline,
      'We found this from one enquiry. See where NOVUS could be finding more opportunity across Ensum Brown.',
    );
    assert.ok(built.systemic_bridge.includes('not in place of them'));
    ok('the CTA gives a reason to book, and the bridge line is the locked copy');

    assert.deepStrictEqual(reasons, [], `unexpected review reasons: ${reasons.join(' | ')}`);
    assert.strictEqual(status, 'ready');
    assert.strictEqual(built.demo_status, 'ready');
    assert.strictEqual(built.review_reasons, '');
    assert.strictEqual(built.ready_at, '2026-08-24T10:00:00.000Z');
    ok('a complete probe compiles straight to ready, with ready_at stamped');

    // The snapshot has to carry the upstream context a human needs to debug it
    // without opening five other tabs.
    assert.strictEqual(built.probe_reference, 'RM-0042');
    assert.strictEqual(built.portal, 'rightmove');
    assert.strictEqual(built.human_contact, 'yes');
    assert.strictEqual(built.grade, 'B');
    assert.strictEqual(built.property_image_status, 'ok');
    assert.strictEqual(built.compiled_at, '2026-08-24T10:00:00.000Z');
    assert.strictEqual(built.compiled_by, 'auto');
    ok('the snapshot carries probe_reference, portal, human_contact, grade and provenance');
  }
  {
    // A missing image is a warning, never a failure.
    const { store } = makeWorkbook();
    seedWeakSeller(store);
    const probe = Object.fromEntries(PROBES_HEADER.map((k, i) => [k, store.PROBES[2][i] ?? '']));
    const personalisation = Object.fromEntries(PERSONALISATION_HEADER.map((k, i) => [k, store.PERSONALISATION[1][i] ?? '']));
    const { row: built, reasons } = buildDemoRow({
      probe, agency: { agency_name: 'Ensum Brown' }, intelligence: {}, findings: [], personalisation,
      propertyImageUrl: '', propertyImageStatus: 'unavailable',
    });
    assert.strictEqual(built.property_image_url, '');
    // A MISSING IMAGE IS NOT A REVIEW REASON — the placeholder card carries it.
    assert.ok(!reasons.some((r) => r.toLowerCase().includes('image')));
    assert.strictEqual(built.property_image_status, 'unavailable');
    ok('a blank property image is recorded in property_image_status, never as a review reason');
    assert.strictEqual(built.response_time, '', 'no INTELLIGENCE row means no invented response time');
    ok('missing INTELLIGENCE renders as absent, never as a guess');
  }

  // ══ Part C — journey support gate ═════════════════════════════════════════
  console.log('\nPart C — hero_journey support');
  {
    for (const journey of SUPPORTED_HERO_JOURNEYS) {
      assert.strictEqual(journeySupport(journey).supported, true, `${journey} should be supported`);
    }
    ok(`all four shell journeys are supported: ${SUPPORTED_HERO_JOURNEYS.join(', ')}`);

    // The three the pipeline can still emit, which have no demo designed yet.
    for (const journey of ['automated_ack_only', 'strong_handling_database_opportunity', 'strong_handling_no_opportunity']) {
      const support = journeySupport(journey);
      assert.strictEqual(support.supported, false);
      assert.ok(support.reason.includes(journey));
    }
    ok('the three unsupported pipeline journeys are refused by name, not fudged');
    assert.strictEqual(journeySupport('').supported, false);
    ok('a blank hero_journey is refused');

    assert.strictEqual(journeySupport('weak_seller_qualification').warning, undefined);
    for (const journey of ['complete_miss', 'slow_response_gap', 'fast_response_stalled_follow_up']) {
      assert.ok(journeySupport(journey).warning.includes('draft copy'));
    }
    ok('only weak_seller_qualification is authored; the other three flag for review');
  }
  {
    // The refusal has to happen BEFORE anything is written.
    const { store } = makeWorkbook();
    seedWeakSeller(store, { heroJourney: 'strong_handling_no_opportunity' });
    const probe = Object.fromEntries(PROBES_HEADER.map((k, i) => [k, store.PROBES[2][i] ?? '']));
    const personalisation = Object.fromEntries(PERSONALISATION_HEADER.map((k, i) => [k, store.PERSONALISATION[1][i] ?? '']));
    assert.throws(
      () => buildDemoRow({ probe, agency: {}, intelligence: {}, findings: [], personalisation }),
      (err) => err.code === 'unsupported_hero_journey',
    );
    ok('an unsupported journey throws before a row is built');
  }

  // ══ Part D — ready vs needs_review ════════════════════════════════════════
  console.log('\nPart D — ready vs needs_review');
  {
    const complete = {
      agency_name: 'Ensum Brown',
      property_address: 'Barn Field, Chevington',
      commercial_consequence: 'A valuation was never booked.',
      positive_observation: 'You came back inside 23 minutes.',
      human_contact: 'yes',
      novus_detected_json: JSON.stringify([{ label: 'Something real' }]),
      observed_events_json: JSON.stringify([{ label: 'a' }, { label: 'b' }]),
    };
    assert.deepStrictEqual(reviewReasonsFor(complete), []);
    assert.strictEqual(statusFromReasons([]), 'ready');
    ok('a complete snapshot is ready');

    const cases = [
      ['agency_name', { agency_name: '' }, 'agency_name'],
      ['property_address', { property_address: '' }, 'property_address'],
      ['commercial_consequence', { commercial_consequence: '' }, 'commercial_consequence'],
      ['positive_observation (with human contact)', { positive_observation: '' }, 'positive_observation'],
      ['novus_detected', { novus_detected_json: '[]' }, 'novus_detected'],
      ['observed_events', { observed_events_json: JSON.stringify([{ label: 'a' }]) }, 'observed events'],
    ];
    for (const [name, patch, needle] of cases) {
      const reasons = reviewReasonsFor({ ...complete, ...patch });
      assert.ok(reasons.some((r) => r.includes(needle)), `${name} should be a review reason`);
      assert.strictEqual(statusFromReasons(reasons), 'needs_review');
    }
    ok('each missing critical field is named as a review reason and forces needs_review');

    // The one exception that stops every complete_miss demo being flagged for
    // a positive that genuinely does not exist.
    const noContact = { ...complete, positive_observation: '', human_contact: 'none' };
    assert.deepStrictEqual(reviewReasonsFor(noContact), []);
    ok('a blank positive observation is fine where nobody responded (human_contact=none)');

    // An unreviewed journey is a review reason on its own.
    const draftJourney = reviewReasonsFor(complete, { journeyWarning: journeySupport('slow_response_gap').warning });
    assert.strictEqual(draftJourney.length, 1);
    assert.strictEqual(statusFromReasons(draftJourney), 'needs_review');
    ok('an unreviewed journey alone is enough to hold a demo at needs_review');
  }

  // ══ Part E — slugs ════════════════════════════════════════════════════════
  console.log('\nPart E — demo slugs');
  {
    const slug = buildDemoSlug({ agencyName: 'Ensum Brown', probeReference: 'RM-0042', probeId: 'prb_a' });
    assert.strictEqual(slug, 'ensum-brown-rm-0042');
    ok('slug is readable and deterministic: ensum-brown-rm-0042');

    const owners = new Map([['ensum-brown-rm-0042', 'prb_a']]);
    assert.strictEqual(
      buildDemoSlug({ agencyName: 'Ensum Brown', probeReference: 'RM-0042', probeId: 'prb_a' }, owners),
      'ensum-brown-rm-0042',
    );
    ok('rebuilding the SAME probe keeps its URL');
    assert.strictEqual(
      buildDemoSlug({ agencyName: 'Ensum Brown', probeReference: 'RM-0042', probeId: 'prb_b' }, owners),
      'ensum-brown-rm-0042-2',
    );
    ok('a DIFFERENT probe never steals an existing demo URL');
    assert.strictEqual(
      buildDemoSlug({ agencyName: "Ashton's & Co", probeReference: 'RM-1', probeId: 'p' }),
      'ashtons-and-co-rm-1',
    );
    ok('punctuation and ampersands slugify cleanly');
  }

  // ══ Part F — render-ready projection ══════════════════════════════════════
  console.log('\nPart F — what the browser receives');
  {
    const rendered = toRenderReady(builtRow);
    for (const internal of ['agency_id', 'probe_id', 'personalisation_id', 'demo_id']) {
      assert.ok(!(internal in rendered), `${internal} must never reach the browser`);
    }
    ok('pipeline keys (probe_id, agency_id, personalisation_id, demo_id) are stripped');
    for (const key of Object.keys(rendered)) assert.ok(!key.endsWith('_json'), `${key} should be parsed, not raw`);
    assert.ok(Array.isArray(rendered.observed_events) && rendered.observed_events.length > 0);
    assert.ok(Array.isArray(rendered.novus_actions) && rendered.novus_actions.length > 0);
    ok('the *_json collections arrive parsed, so the page never JSON.parses a cell');

    const mangled = toRenderReady({ ...builtRow, observed_events_json: '{not json' });
    assert.deepStrictEqual(mangled.observed_events, []);
    ok('a hand-mangled JSON cell renders as an absent section, never a broken page');
  }

  // ══ Part G/H/I/J — the route, end to end ══════════════════════════════════
  console.log('\nPart G — serving one demo through /api/demo');
  {
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    __setRepoForTests(repo);

    // The demo is compiled by the pipeline step, not by a human — exactly as
    // lib/rebuild-pass.mjs calls it. No network: the image is supplied.
    const compiled = await compileDemos(repo, {
      justPersonalised: ['prb_demo_001'],
      suppliedImageUrl: 'https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_656x437.jpeg',
    });
    assert.strictEqual(compiled.demos_created, 1);
    assert.strictEqual(compiled.demos_ready, 1);
    assert.strictEqual(compiled.results[0].demo_slug, 'ensum-brown-rm-0042');
    assert.strictEqual(compiled.results[0].demo_url, '/demo/ensum-brown-rm-0042');
    assert.strictEqual(demoRowsOf(store).length, 1);
    ok('the pipeline step writes exactly one DEMOS row and returns /demo/{slug}');

    // Nothing upstream may be touched by a demo compile.
    assert.strictEqual(store.PROBES.length, 3);
    assert.strictEqual(store.PERSONALISATION.length, 2);
    assert.strictEqual(store.INTELLIGENCE.length, 2);
    assert.strictEqual(store.DIAGNOSIS_FINDINGS.length, 3);
    ok('compiling a demo writes nothing back into PROBES/INTELLIGENCE/FINDINGS/PERSONALISATION');

    // GET — the prospect's request.
    const getRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042' }, auth: false }), getRes);
    assert.strictEqual(getRes.statusCode, 200);
    assert.strictEqual(getRes.body.needs_review, false);
    assert.strictEqual(getRes.body.demo.agency_name, 'Ensum Brown');
    assert.ok(!('probe_id' in getRes.body.demo));
    assert.strictEqual(getRes.headers['Cache-Control'], 'no-store');
    ok('GET /api/demo?slug=… serves a ready demo WITHOUT auth');

    console.log('\nPart H — view telemetry');
    assert.strictEqual(demoRowsOf(store)[0].view_count, '1');
    const firstViewedAt = demoRowsOf(store)[0].first_viewed_at;
    assert.ok(firstViewedAt, 'first_viewed_at is stamped on the first view');
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    assert.strictEqual(demoRowsOf(store)[0].view_count, '2');
    assert.strictEqual(demoRowsOf(store)[0].first_viewed_at, firstViewedAt);
    ok('each view increments view_count; first_viewed_at is stamped once');

    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042', preview: '1' }, auth: false }), mockRes());
    assert.strictEqual(demoRowsOf(store)[0].view_count, '2');
    ok('?preview=1 lets us open our own demo without inflating the count');

    // Case-insensitive slug: a link pasted with different casing still resolves.
    const casedRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'Ensum-Brown-RM-0042', preview: '1' }, auth: false }), casedRes);
    assert.strictEqual(casedRes.statusCode, 200);
    ok('a slug typed with different casing still resolves');

    const missingRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'nobody-here' }, auth: false }), missingRes);
    assert.strictEqual(missingRes.statusCode, 404);
    ok('an unknown slug is a clean 404');

    console.log('\nPart I — CTA telemetry');
    await demoHandler(mockReq({ body: { action: 'cta_click', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    const clickedAt = demoRowsOf(store)[0].cta_clicked_at;
    assert.ok(clickedAt, 'the CTA click is recorded');
    await demoHandler(mockReq({ body: { action: 'cta_click', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    assert.strictEqual(demoRowsOf(store)[0].cta_clicked_at, clickedAt);
    ok('the FIRST CTA click wins — a reload is not a second signal');

    await demoHandler(mockReq({ body: { action: 'meeting_booked', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    assert.ok(demoRowsOf(store)[0].meeting_booked_at);
    ok('a booked meeting is recorded separately from the click that opened the calendar');

    console.log('\nPart J — a recompile updates the snapshot and nothing else');
    // THE CASE THIS EXISTS FOR: a Personalisation rebuild before outreach
    // recompiles the demo. Identity, history and analytics must all survive it.
    const before = demoRowsOf(store)[0];
    assert.ok(before.view_count && before.cta_clicked_at && before.meeting_booked_at,
      'the fixture must have accumulated analytics before this check means anything');

    const recompiled = await compileDemos(repo, { probeIds: ['prb_demo_001'], force: true, compiledBy: 'manual', resolveImageUrl: noImage });
    assert.strictEqual(recompiled.demos_updated, 1);
    assert.strictEqual(demoRowsOf(store).length, 1, 'a recompile must never append a second row');

    const after = demoRowsOf(store)[0];
    assert.strictEqual(after.demo_slug, before.demo_slug, 'the URL must survive a recompile');
    assert.strictEqual(after.demo_id, before.demo_id);
    assert.strictEqual(after.created_at, before.created_at);
    assert.strictEqual(after.ready_at, before.ready_at, 'ready_at is stamped once, never moved');
    assert.strictEqual(after.demo_status, 'ready');
    assert.strictEqual(after.property_image_url, before.property_image_url, 'a recompile keeps the image it already has');
    assert.strictEqual(after.compiled_by, 'manual', 'provenance records who recompiled it');
    for (const column of ANALYTICS_COLUMNS) {
      assert.strictEqual(after[column], before[column], `${column} must survive a recompile`);
    }
    ok(`recompile preserves the URL, demo_id, created_at, ready_at, the image and all ${ANALYTICS_COLUMNS.length} analytics fields`);

    console.log('\nPart K — the write path is authed, the read path is not');
    const noAuth = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' }, auth: false }), noAuth);
    assert.strictEqual(noAuth.statusCode, 401);
    ok('the recovery build without the NOVUS credential is a 401');

    // The recovery action goes through the SAME compiler.
    const recoveryRes = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' } }), recoveryRes);
    assert.strictEqual(recoveryRes.statusCode, 200, JSON.stringify(recoveryRes.body));
    assert.strictEqual(recoveryRes.body.demo_slug, 'ensum-brown-rm-0042');
    assert.strictEqual(recoveryRes.body.demo_status, 'ready');
    assert.strictEqual(demoRowsOf(store).length, 1);
    assert.strictEqual(demoRowsOf(store)[0].view_count, before.view_count);
    ok('the authed recovery build reuses the pipeline compiler and preserves analytics too');
  }
  {
    // An archived demo is deliberately gone.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    __setRepoForTests(repo);
    await compileDemos(repo, { justPersonalised: ['prb_demo_001'], suppliedImageUrl: 'https://media.rightmove.co.uk/x/IMG_01.jpeg' });

    await demoHandler(mockReq({ body: { action: 'archive', probe_id: 'prb_demo_001' } }), mockRes());
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'archived');
    const res = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042' }, auth: false }), res);
    assert.strictEqual(res.statusCode, 404);
    ok('an archived demo is a 404');

    // Preserved exactly: archived stays gone even under the internal preview
    // mechanism — preview reveals an unfinished demo, never a retired one.
    const previewRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042', preview: '1' }, auth: false }), previewRes);
    assert.strictEqual(previewRes.statusCode, 404);
    ok('?preview=1 does not resurrect an archived demo either');

    // ARCHIVING IS STICKY: a later recompile refreshes the snapshot but must
    // not quietly bring a retired link back to life.
    await compileDemos(repo, { probeIds: ['prb_demo_001'], force: true, resolveImageUrl: noImage });
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'archived');
    ok('a recompile does not un-archive a retired demo');

    await demoHandler(mockReq({ body: { action: 'restore', probe_id: 'prb_demo_001' } }), mockRes());
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'ready');
    ok('restore brings it back to the status its content actually earns');
  }
  {
    // The 422 an unsupported journey produces at the route boundary.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store, { heroJourney: 'automated_ack_only' });
    __setRepoForTests(repo);
    const res = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' } }), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.hero_journey, 'automated_ack_only');
    assert.strictEqual(demoRowsOf(store).length, 0);
    ok('an unsupported journey is a 422 and writes no row');

    // The automatic pass reports it rather than failing — a journey with no
    // demo behind it must not take the pipeline down.
    const summary = await compileDemos(repo, { justPersonalised: ['prb_demo_001'], resolveImageUrl: noImage });
    assert.strictEqual(summary.skipped_unsupported_journey, 1);
    assert.strictEqual(summary.demos_compiled, 0);
    assert.strictEqual(demoRowsOf(store).length, 0);
    ok('the automatic pass counts an unsupported journey and carries on');
  }
  {
    // An unreviewed journey compiles, but is held at needs_review.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store, { heroJourney: 'slow_response_gap' });
    __setRepoForTests(repo);
    const summary = await compileDemos(repo, { justPersonalised: ['prb_demo_001'], resolveImageUrl: noImage });
    assert.strictEqual(summary.demos_compiled, 1);
    assert.strictEqual(summary.demos_needs_review, 1);
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'needs_review');
    assert.ok(demoRowsOf(store)[0].review_reasons.includes('draft copy'));
    assert.strictEqual(demoRowsOf(store)[0].ready_at, '', 'a demo that was never ready has no ready_at');
    ok('an unreviewed journey compiles to needs_review with the reason on the row');

    // A NORMAL request must not expose it — same 404 an unknown slug gets,
    // so the outside world cannot tell "not ready" from "never existed".
    const normalRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: demoRowsOf(store)[0].demo_slug }, auth: false }), normalRes);
    assert.strictEqual(normalRes.statusCode, 404);
    assert.strictEqual(normalRes.body.error, 'No demo found for this link');
    const unknownRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'genuinely-unknown-slug' }, auth: false }), unknownRes);
    assert.strictEqual(unknownRes.body.error, normalRes.body.error, 'the two 404s must read identically');
    ok('a normal request to a needs_review demo 404s exactly like an unknown slug');

    // Only ?preview=1 — the internal viewing mechanism — is allowed to see it.
    const res = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: demoRowsOf(store)[0].demo_slug, preview: '1' }, auth: false }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.needs_review, true);
    ok('?preview=1 still resolves it, flagged, so it can be checked before sending');

    // Telemetry must never fire off a request that never rendered the page.
    assert.strictEqual(demoRowsOf(store)[0].view_count, '', 'the blocked normal request must not have counted as a view');
    ok('the blocked normal request left no view recorded');
  }
  {
    // A probe with no PERSONALISATION row has no story to tell yet.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    store.PERSONALISATION = [PERSONALISATION_HEADER.slice()];
    __setRepoForTests(repo);
    const res = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' } }), res);
    assert.strictEqual(res.statusCode, 409);
    ok('a probe with no PERSONALISATION row is refused with a 409, not a half-demo');
  }
  {
    // A PERSONALISATION row that exists but was never finalised (no
    // primary_narrative) is NOT a story — compiling from it would put a demo
    // in front of a prospect built on half an answer.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    store.PERSONALISATION[1][PERSONALISATION_HEADER.indexOf('primary_narrative')] = '';
    __setRepoForTests(repo);
    const summary = await compileDemos(repo, { resolveImageUrl: noImage });
    assert.strictEqual(summary.demos_compiled, 0);
    assert.strictEqual(demoRowsOf(store).length, 0);
    ok('an unfinalised PERSONALISATION row compiles no demo');
  }
  {
    // A workbook without the tab must say so, not 500.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    delete store.DEMOS;
    __setRepoForTests(repo);
    const getRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'anything' }, auth: false }), getRes);
    assert.strictEqual(getRes.statusCode, 404);
    const buildRes = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' } }), buildRes);
    assert.strictEqual(buildRes.statusCode, 409);
    assert.ok(buildRes.body.error.includes('DEMOS'));
    ok('a workbook with no DEMOS tab yet returns a clear 404/409, never a 500');

    // And the automatic pass is a flagged no-op rather than a pipeline failure.
    const summary = await compileDemos(repo, { justPersonalised: ['prb_demo_001'], resolveImageUrl: noImage });
    assert.strictEqual(summary.demos_tab_missing, true);
    assert.strictEqual(summary.demos_compiled, 0);
    assert.deepStrictEqual(summary.problems, []);
    ok('a missing DEMOS tab makes the pipeline step a flagged no-op, never a throw');
  }

  // ══ Part L — AUTOMATIC COMPILATION ════════════════════════════════════════
  // The headline behaviour: nobody runs a build command. A probe that finishes
  // PERSONALISATION comes out of the SAME pass with a live demo.
  console.log('\nPart L — the demo compiles itself when PERSONALISATION completes');
  {
    const { store, repo } = makeWorkbook({ DIAGNOSIS: [DIAGNOSIS_HEADER.slice()] });
    seedPipelineReadyProbe(store);
    __setRepoForTests(repo);
    personalisationAiCalls = 0;
    __setAiCallerForTests(fakePersonalisationAi);

    // Exactly what api/novus/intelligence/finalize.js (the cron) and the
    // "Rebuild Intelligence" button run.
    const summary = await runRebuildPass(repo, { maxAiCalls: 10 });

    assert.strictEqual(summary.personalisation.personalisation_created, 1, JSON.stringify(summary.personalisation.problems));
    assert.deepStrictEqual(summary.personalisation.personalised_probe_ids, ['prb_auto_001']);
    ok('PERSONALISATION reports which probes it wrote, so the demo step knows what is new');

    assert.ok(summary.demos, 'the pass reports a demos summary');
    assert.strictEqual(summary.demos.demos_created, 1, JSON.stringify(summary.demos.problems));
    assert.strictEqual(summary.demos.results[0].reason, 'personalisation_completed');
    ok('ONE pass: PERSONALISATION completes and the DEMOS row is compiled in the same invocation');

    // ZERO AI IN DEMOS COMPILATION: exactly one AI call happened in the whole
    // pass — the personalisation call. If compileDemos() had called AI to
    // select/rank/summarise evidence, fakePersonalisationAi would have thrown
    // on the unexpected tool name and this pass would already have failed;
    // this count makes the "zero" explicit rather than merely implied.
    assert.strictEqual(personalisationAiCalls, 1, 'DEMOS compilation must add no AI calls beyond personalisation');
    ok('exactly one AI call for the whole pass — DEMOS compilation made none');

    const demo = demoRowsOf(store)[0];
    assert.strictEqual(demo.probe_id, 'prb_auto_001');
    assert.strictEqual(demo.hero_journey, 'weak_seller_qualification');
    assert.strictEqual(demo.demo_slug, 'auto-agency-rm-0099');
    assert.strictEqual(demo.compiled_by, 'auto');
    assert.ok(demo.compiled_at);
    ok(`the compiled demo is live at /demo/${demo.demo_slug} with no human step`);

    // The observed events are real evidence from the seeded COMMUNICATIONS
    // row, not just AI-derived personalisation copy.
    const autoEvents = JSON.parse(demo.observed_events_json);
    assert.ok(autoEvents.some((e) => e.label.startsWith('First response')), 'the compiled demo carries real evidence too');

    // And it renders — the same GET a prospect makes.
    const getRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: demo.demo_slug }, auth: false }), getRes);
    assert.strictEqual(getRes.statusCode, 200, JSON.stringify(getRes.body));
    assert.strictEqual(getRes.body.demo.agency_name, 'Auto Agency');
    assert.ok(getRes.body.demo.observed_events.length >= 2);
    ok('the automatically compiled demo serves render-ready JSON straight away, with real evidence in it');

    // A second pass must be a no-op: PERSONALISATION is frozen, the demo is
    // up to date, nothing is rewritten and no second row appears.
    const second = await runRebuildPass(repo, { maxAiCalls: 10 });
    assert.strictEqual(second.personalisation.personalisation_created, 0);
    assert.strictEqual(second.demos.demos_compiled, 0);
    assert.strictEqual(demoRowsOf(store).length, 1);
    ok('a second pass compiles nothing — an up-to-date demo is left alone');

    __setAiCallerForTests(null);
  }
  {
    // SELF-HEALING: the probe was personalised before the DEMOS tab existed.
    // This is the case that makes "never run a build command" true for the
    // demos that already exist, not just the ones from now on.
    const { store, repo } = makeWorkbook({ DIAGNOSIS: [DIAGNOSIS_HEADER.slice()] });
    seedWeakSeller(store, { propertyUrl: '' });      // already personalised
    __setRepoForTests(repo);
    __setAiCallerForTests(async () => { throw new Error('no AI call should be needed'); });

    const summary = await runRebuildPass(repo, { maxAiCalls: 10 });
    assert.strictEqual(summary.personalisation.personalisation_created, 0, 'nothing left to personalise');
    assert.strictEqual(summary.demos.demos_created, 1);
    assert.strictEqual(summary.demos.results[0].reason, 'missing_demo_row');
    assert.strictEqual(demoRowsOf(store).length, 1);
    ok('an already-personalised probe with no demo row is picked up by the next pass, with no AI call');

    __setAiCallerForTests(null);
  }
  {
    // Budgets: a pass compiles what it can and reports the rest, rather than
    // running past a serverless time limit.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store, { probeId: 'prb_a', probeReference: 'RM-1', agencyId: 'ag_a', agencyName: 'Agency A' });
    seedWeakSeller(store, { probeId: 'prb_b', probeReference: 'RM-2', agencyId: 'ag_b', agencyName: 'Agency B' });
    __setRepoForTests(repo);

    const first = await compileDemos(repo, { maxCompiles: 1, maxImageFetches: 0, resolveImageUrl: noImage });
    assert.strictEqual(first.demos_compiled, 1);
    assert.strictEqual(first.remaining_demos, 1);
    assert.strictEqual(first.images_pending, 1, 'no image budget leaves the image pending, not failed');
    assert.strictEqual(demoRowsOf(store)[0].property_image_status, 'pending');
    ok('a capped pass compiles what it can and reports the remainder');

    // The next pass finishes the job AND retries the pending image.
    const second = await compileDemos(repo, { maxImageFetches: 5, resolveImageUrl: noImage });
    assert.strictEqual(second.demos_compiled, 2, 'the second demo, plus the pending-image retry');
    assert.strictEqual(demoRowsOf(store).length, 2);
    assert.ok(demoRowsOf(store).every((d) => d.property_image_status !== 'pending'));
    ok('the next pass finishes the remainder and retries every pending image');

    // A settled failure is NOT retried — a dead listing must not be re-fetched
    // on every pass forever.
    assert.ok(demoRowsOf(store).some((d) => d.property_image_status === 'unavailable'));
    const third = await compileDemos(repo, { maxImageFetches: 5, resolveImageUrl: anImage });
    assert.strictEqual(third.demos_compiled, 0);
    assert.strictEqual(third.images_fetched, 0);
    ok('an image marked unavailable is never re-fetched automatically');

    assert.strictEqual(
      new Set(demoRowsOf(store).map((d) => d.demo_slug)).size, 2,
      'two probes compiled in one pass must not share a URL',
    );
    ok('two probes compiled in the same pass get distinct slugs');
  }

  // ══ Part M — THE PROSPECT PATH READS ONE TAB ══════════════════════════════
  console.log('\nPart M — opening a demo reads the DEMOS snapshot and nothing else');
  {
    const { store, reads, repo } = makeWorkbook();
    seedWeakSeller(store);
    __setRepoForTests(repo);
    await compileDemos(repo, { justPersonalised: ['prb_demo_001'], suppliedImageUrl: 'https://media.rightmove.co.uk/x/IMG_01.jpeg' });

    // Everything up to here was compilation. From this point, only the
    // prospect's own request.
    reads.length = 0;
    const getRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042' }, auth: false }), getRes);
    assert.strictEqual(getRes.statusCode, 200);

    assert.deepStrictEqual([...new Set(reads)], ['DEMOS'],
      `opening a demo must read DEMOS only — it read: ${[...new Set(reads)].join(', ')}`);
    ok('GET /api/demo touches DEMOS and NOTHING else — no PROBES, INTELLIGENCE, FINDINGS or PERSONALISATION join');

    // The payload is complete on its own: every field the four beats need is
    // already on the row, so the page has nothing left to look up.
    const demo = getRes.body.demo;
    for (const field of [
      'agency_name', 'property_address', 'property_price', 'property_url', 'property_image_url',
      'enquiry_date', 'enquiry_time', 'seller_declared', 'response_time',
      'demo_hook', 'positive_observation', 'demo_reveal', 'main_finding',
      'commercial_consequence', 'systemic_bridge', 'cta_headline',
    ]) {
      assert.ok(field in demo, `${field} must be on the render-ready payload`);
    }
    for (const collection of ['observed_events', 'novus_detected', 'novus_decisions', 'novus_actions']) {
      assert.ok(Array.isArray(demo[collection]) && demo[collection].length > 0, `${collection} must be populated`);
    }
    ok('the snapshot alone carries every field all four beats render');

    // Telemetry is one write on the same row — never a read of another tab.
    reads.length = 0;
    await demoHandler(mockReq({ body: { action: 'cta_click', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    assert.deepStrictEqual([...new Set(reads)], ['DEMOS']);
    ok('CTA telemetry also touches DEMOS only');
  }

  // ══ Part N — COMMUNICATIONS evidence, zero AI ════════════════════════════
  console.log('\nPart N — observed-events evidence, drawn from COMMUNICATIONS, zero AI');
  {
    assert.deepStrictEqual(selectCommunicationEvidence({ communications: [] }), []);
    assert.deepStrictEqual(selectCommunicationEvidence({}), []);
    ok('no COMMUNICATIONS rows -> no evidence events (never a throw, never a guess)');
  }
  {
    // An auto-acknowledgement is never evidence of the team doing something —
    // isHumanCommunication() (the same classifier lib/observation.mjs's own
    // rollup uses) must exclude it, exactly as it does for the grade.
    const autoAckOnly = [row(COMMUNICATIONS_HEADER, {
      communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z',
      channel: 'email', automated_or_human: 'automated', communication_classification: 'auto_acknowledgement',
      body_text: 'Thanks for your enquiry, a member of the team will be in touch.',
    })].map((r) => Object.fromEntries(COMMUNICATIONS_HEADER.map((k, i) => [k, r[i] ?? ''])));
    assert.deepStrictEqual(selectCommunicationEvidence({ communications: autoAckOnly }), []);
    ok('an automated acknowledgement alone produces no evidence event');
  }
  {
    // Exactly one human touch, no follow-up: the "absence" case the brief
    // names explicitly. The story is always the same two beats — what came
    // back first, and what the remaining attempts were (here, none).
    const oneTouch = [{
      communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:05:00.000Z',
      channel: 'email', automated_or_human: 'human',
      body_text: 'Hi Sam, thanks very much for your enquiry. Is Saturday or Sunday any good for a viewing?',
    }];
    const events = selectCommunicationEvidence({
      communications: oneTouch, intelligence: { seller_recognition: 'none' }, sellerDeclared: true,
    });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].label, 'First response');
    // THE MOST USEFUL SENTENCE, not the first few words: the greeting and the
    // thanks are scored down, the sentence that shows what they actually did
    // is the one shown — and it is a literal extract, never a rewrite.
    // 09:05 UTC is 10:05 in Europe/London during BST (August).
    assert.strictEqual(events[0].detail, '"Is Saturday or Sunday any good for a viewing?" (email, 10:05)');
    assert.strictEqual(events[1].label, 'Other contact attempts');
    assert.strictEqual(events[1].detail, 'No further contact attempts were made. The seller opportunity was still never explored.');
    assert.strictEqual(events[1].tone, 'gap');
    ok('a single touch yields the useful sentence of the first response and an explicit "no further attempts"');
  }
  {
    // First contact (email) + a later voicemail + a further attempt the next
    // day. The remaining attempts are SUMMARISED, not quoted one by one.
    const touches = [
      { communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z', channel: 'email', automated_or_human: 'human', subject: 'Re: enquiry', body_text: 'Thanks for your enquiry. Happy to arrange a viewing whenever suits you.' },
      { communication_id: 'c2', probe_id: 'p', occurred_at: '2026-08-01T10:10:00.000Z', channel: 'voice', automated_or_human: 'human', voicemail_present: 'TRUE', transcript: 'Hi, just calling about the property, give me a ring back.' },
      { communication_id: 'c3', probe_id: 'p', occurred_at: '2026-08-02T10:00:00.000Z', channel: 'sms', automated_or_human: 'human', body_text: 'Following up. Are you still interested in viewing this weekend?' },
    ];
    const events = selectCommunicationEvidence({
      communications: touches,
      intelligence: { viewing_progression: 'slot_offered', seller_recognition: 'acknowledged' },
      sellerDeclared: true,
    });
    assert.strictEqual(events.length, 2, 'the story is always exactly two communication beats');
    assert.strictEqual(events[0].label, 'First response');
    assert.ok(events[0].detail.startsWith('"Happy to arrange a viewing whenever suits you."'));
    assert.strictEqual(
      events[1].detail,
      '2 further contact attempts were made by phone and SMS, focused on progressing the viewing.'
      + ' The seller position was acknowledged and never qualified.',
    );
    ok('the remaining attempts are summarised by count, channel and what they were for');

    // An unanswered call as the FIRST touch is stated as exactly that —
    // no transcript excerpt, no attribution tag.
    const firstIsVoicemail = [
      { communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z', channel: 'voice', automated_or_human: 'human', voicemail_present: 'TRUE', transcript: 'Hi, calling about the enquiry.' },
      { communication_id: 'c2', probe_id: 'p', occurred_at: '2026-08-01T09:05:00.000Z', channel: 'email', automated_or_human: 'human', body_text: 'Following up my call by email.' },
    ];
    const events2 = selectCommunicationEvidence({ communications: firstIsVoicemail });
    assert.strictEqual(events2[0].detail, 'Voicemail left.');
    ok('an unanswered first call reads simply as "Voicemail left."');
  }
  {
    // A seller position that DID reach a valuation gets no gap sentence at
    // all — there was no gap to name.
    const touches = [
      { communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z', channel: 'email', automated_or_human: 'human', body_text: 'Happy to book a viewing, and we can offer a free valuation on your own place.' },
      { communication_id: 'c2', probe_id: 'p', occurred_at: '2026-08-02T09:00:00.000Z', channel: 'email', automated_or_human: 'human', body_text: 'Just checking back about the valuation appointment.' },
    ];
    const events = selectCommunicationEvidence({
      communications: touches,
      intelligence: { viewing_progression: 'booked', seller_recognition: 'valuation_offered' },
      sellerDeclared: true,
    });
    assert.strictEqual(events[1].detail, '1 further contact attempt was made by email, focused on progressing the viewing.');
    assert.strictEqual(events[1].tone, 'good');
    ok('no seller-gap sentence is invented where the valuation was actually offered');
  }
  {
    // Deterministic extraction, never a rewrite: the shown sentence is always
    // a literal substring of the stored text, and a single over-long sentence
    // is cut with an ellipsis rather than reworded.
    const longSentence = 'We can arrange a viewing for you ' + 'at any time that suits '.repeat(9) + 'this week';
    const long = selectCommunicationEvidence({
      communications: [{ communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z', channel: 'voice', automated_or_human: 'human', transcript: longSentence }],
    });
    const longDetail = long[0].detail.replace(/^"|" \(.*\)$/g, '');
    assert.ok(longDetail.endsWith('…'), 'a long excerpt is marked as truncated');
    assert.ok(longDetail.length <= 171, `truncated excerpt must stay short, got ${longDetail.length} chars`);
    assert.ok(longSentence.startsWith(longDetail.slice(0, -1)), 'the excerpt is a literal prefix of the original text - never reworded');

    const shortTranscript = 'Hi, still interested in the viewing this weekend?';
    const short = selectCommunicationEvidence({
      communications: [{ communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z', channel: 'voice', automated_or_human: 'human', transcript: shortTranscript }],
    });
    assert.ok(short[0].detail.startsWith(`"${shortTranscript}"`), 'short text is shown whole, verbatim - no rewriting');
    ok('a chosen sentence is always a literal extract; an over-long one is mechanically truncated');
  }
  {
    // The declaration summary is derived from the probe's OWN clause, and says
    // whether that property was already on the market — never guessed.
    assert.strictEqual(
      sellerDeclarationSummary('Declared: has a property to sell, yes, it is not yet on the market'),
      'Buyer declared they also had a property to sell, and that it was not yet on the market.',
    );
    assert.strictEqual(
      sellerDeclarationSummary('Declared: has a property to sell, already on the market'),
      'Buyer declared they also had a property to sell, and that it was already on the market.',
    );
    assert.strictEqual(
      sellerDeclarationSummary('Declared: has a property to sell'),
      'Buyer declared they also had a property to sell.',
    );
    ok('the enquiry line states the declared market position from the probe\'s own words, or omits it');
  }
  {
    // buildObservedEvents(): the metric strip is built from INTELLIGENCE alone,
    // so a probe with no matched COMMUNICATIONS still shows the quantified
    // summary — it simply has no real message to put behind it.
    const events = buildObservedEvents({
      intelligence: { contact_attempts: '2', channels_used: 'voice,email' },
      sellerDeclared: false,
      responseTime: '10 minutes',
      communications: [],
    });
    assert.ok(events.every((e) => e.kind === 'metric'));
    assert.ok(events.some((e) => e.label === '2 contact attempts' && e.detail === 'phone and email'));
    assert.ok(!events.some((e) => e.label.startsWith('First response')));
    ok('with no matched COMMUNICATIONS the metric strip still stands, with no artefact behind it');

    // A probe that never declared a seller carries no seller metrics at all —
    // "2 opportunities" and "No valuation progression" would both be untrue.
    assert.ok(!events.some((e) => e.label === '2 opportunities'));
    assert.ok(!events.some((e) => e.label === 'No valuation progression'));

    // Nothing established at all: no attempts, no ordinals, no messages. The
    // strip is empty rather than padded, and the demo is flagged for review by
    // reviewReasonsFor() rather than shipping a page with no evidence on it.
    assert.deepStrictEqual(buildObservedEvents({ intelligence: {}, sellerDeclared: false, communications: [] }), []);
    ok('a metric is only shown where the underlying field genuinely established it');
  }

  // ══ Part O — display formatting ═══════════════════════════════════════════
  console.log('\nPart O — display formatting');
  {
    assert.strictEqual(formatResponseTime('0.38'), '23 minutes');
    assert.strictEqual(formatResponseTime('1'), '1 hour');
    assert.strictEqual(formatResponseTime('1.2'), '1 hour 12 minutes');
    assert.strictEqual(formatResponseTime('17.85'), '17.9 hours');
    assert.strictEqual(formatResponseTime('50'), '2 days');
    assert.strictEqual(formatResponseTime(''), '');
    assert.strictEqual(formatResponseTime('not a number'), '');
    ok('response times read the way a person would say them');
    assert.strictEqual(formatChannels('voice,email'), 'phone and email');
    assert.strictEqual(formatChannels('voice,email,sms'), 'phone, email and SMS');
    assert.strictEqual(formatChannels(''), '');
    ok('channels read as prose ("phone and email"), never as raw enum values');
    assert.strictEqual(sentenceCase('you came back inside 23 minutes.'), 'You came back inside 23 minutes.');
    assert.strictEqual(sentenceCase(''), '');
    ok('sentenceCase raises the first letter and rewrites nothing else');
  }

  // ══ Part P — the listing price is never the enquirer's own house ══════════
  console.log("\nPart P — no invented valuations in prospect-facing copy");
  {
    // PERSONALISATION is allowed to cite the confirmed listing price to give
    // the BUYER enquiry a scale. Attaching that same figure to the VENDOR
    // opportunity asserts a value for a property nobody has valued — the one
    // claim this demo must never make.
    assert.strictEqual(
      stripUnsafeSellerValue('a potential £650,000 seller instruction sitting inside the same enquiry was never explored.'),
      'a potential seller instruction sitting inside the same enquiry was never explored.',
    );
    assert.strictEqual(
      stripUnsafeSellerValue('the £375,000 valuation opportunity was never progressed.'),
      'the valuation opportunity was never progressed.',
    );
    ok('a figure attached to the seller opportunity is removed; the point it was making survives');

    // Removing the figure must leave a sentence, not a stump.
    assert.strictEqual(
      stripUnsafeSellerValue('An instruction inside a £420,000 enquiry was left on the table.'),
      'An instruction inside an enquiry was left on the table.',
    );
    ok('the article is repaired, so the sentence still reads');

    // Buyer-side money IS the price of the listing they enquired about.
    const buyerSide = 'you had a £225,000 buyer enquiry in front of you without establishing whether I was ready to move';
    assert.strictEqual(stripUnsafeSellerValue(buyerSide), buyerSide);
    assert.strictEqual(stripUnsafeSellerValue('a valuation was never booked.'), 'a valuation was never booked.');
    assert.strictEqual(stripUnsafeSellerValue(''), '');
    ok('buyer-side money and money-free copy are left exactly as PERSONALISATION wrote them');
  }
  {
    // End to end: the rule runs at COMPILE time, so an unsafe sentence can
    // never reach a DEMOS row — and nothing is written back into the email.
    const { store } = makeWorkbook();
    seedWeakSeller(store, { propertyUrl: '' });
    const probe = Object.fromEntries(PROBES_HEADER.map((k, i) => [k, store.PROBES[2][i] ?? '']));
    const intelligence = Object.fromEntries(INTELLIGENCE_HEADER.map((k, i) => [k, store.INTELLIGENCE[1][i] ?? '']));
    const personalisation = Object.fromEntries(PERSONALISATION_HEADER.map((k, i) => [k, store.PERSONALISATION[1][i] ?? '']));
    personalisation.commercial_consequence =
      'a potential £375,000 seller instruction inside the same enquiry was never explored.';

    const { row: built } = buildDemoRow({
      probe, agency: { agency_name: 'Ensum Brown' }, intelligence, findings: [], personalisation,
      communications: [], now: '2026-08-24T10:00:00.000Z',
    });
    assert.ok(!built.commercial_consequence.includes('£'), 'no invented valuation reaches the row');
    assert.strictEqual(
      built.commercial_consequence,
      'A potential seller instruction inside the same enquiry was never explored.',
    );
    assert.ok(
      personalisation.commercial_consequence.includes('£375,000'),
      'PERSONALISATION is never rewritten — the email is unaffected',
    );
    ok('the demo compiles money-safe copy without touching the personalisation it came from');
  }

  __setRepoForTests(null);
  console.log(`\n✅ novus-demo-selftest: ${passed} checks passed\n`);
}

run().catch((err) => {
  console.error('\n❌ novus-demo-selftest FAILED\n');
  console.error(err);
  process.exit(1);
});
