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
//   P. the listing price is never attached to the enquirer's own house
//   Q. FOUR JOURNEYS THROUGH ONE ROUTE: the same probe told under four
//      hero_journeys produces four different narratives, and inside each
//      one the copy still moves with that probe's own evidence - the
//      seller declaration, seller_recognition, viewing_progression, the
//      measured delay and the follow-up count
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
  demoRecords, effectiveDemoStatus, normaliseSlug, resolveDemoBySlug,
} from '../lib/demos.mjs';
import { compileDemos, compileDecision } from '../lib/demo-compile.mjs';
import { runRebuildPass } from '../lib/rebuild-pass.mjs';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { extractPropertyImageUrl, fetchPropertyImageUrl, isUsablePropertyImage } from '../lib/property-image.mjs';
import {
  journeySupport, SUPPORTED_HERO_JOURNEYS, commercialPriority, heroTitle, HERO_TITLES,
} from '../lib/demo-journeys.mjs';

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
  'fair_observation', 'main_finding', 'commercial_consequence',
  'property_reference', 'email_observation', 'email_commercial_hook',
  'created_at', 'updated_at',
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
    fair_observation: 'you came back inside 23 minutes and followed up twice more across phone and email.',
    main_finding: 'the property I said I had to sell was asked about once and never taken any further.',
    commercial_consequence: 'a valuation that was already inside the enquiry was never booked, and the instruction behind it never entered your pipeline.',
    property_reference: 'Barn Field, Chevington on 17 August at 21:33',
    email_observation: 'You came back inside 23 minutes, but the declared property to sell was never progressed into a valuation.',
    email_commercial_hook: 'So the buyer side moved while the seller opportunity remained unprogressed.',
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
    email_observation: 'You replied within half an hour and progressed the viewing, but the property I said I had to sell was never taken any further.',
    email_commercial_hook: 'So the buyer side moved forward, while the potential seller was missed entirely.',
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
    // THE HERO IS THE FINDING, NOT THE JOURNEY NAME. This probe's declared
    // vendor never reached a seller-side next step, so the strongest finding
    // here is the unworked second opportunity - and the hero is the fixed line
    // for it, never the shell's old global headline.
    assert.strictEqual(built.demo_headline, 'One enquiry. Two opportunities. Only one was seen.');
    assert.ok(
      !/More than one opportunity/i.test(built.demo_headline),
      'the hero is derived from the findings, never the shell default',
    );
    // The reveal says what the finding COST. It never restates the title.
    assert.strictEqual(built.demo_reveal, 'The seller question was asked once, and nothing was built on the answer.');
    assert.notStrictEqual(built.demo_reveal, built.demo_headline);
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

    // THE MINIMUM REAL PROOF, IN ONE FIXED CHRONOLOGY — what was sent, what
    // came back, what it achieved on the buying side, how hard the team kept
    // going, and what became of the declared vendor. ONE actual message: two
    // more quotes proved nothing the first did not.
    assert.deepStrictEqual(artefacts.map((a) => a.label), [
      'Enquiry sent',
      'Fast first response',
      'Buyer / viewing progression',
      'What happened next',
      'Seller opportunity',
    ]);
    // What was sent, and what the buyer declared — INCLUDING that the property
    // was pre-market.
    assert.strictEqual(
      artefacts[0].detail,
      'Barn Field, Chevington, 17 August at 23:34.'
      + ' Buyer declared they also had a property to sell, and that it was not yet on the market.',
    );
    // The measured lag leads. The first touch was an unanswered call, so that
    // is all the rest of the line says.
    assert.strictEqual(artefacts[1].detail, '23 minutes after the enquiry. Voicemail left.');
    // CREDIT WHERE IT IS DUE: the buying side is stated as the good outcome it
    // was, which is what makes the seller line below a contrast, not an attack.
    assert.strictEqual(artefacts[2].detail, 'A specific viewing slot was offered.');
    assert.strictEqual(artefacts[2].tone, 'good');
    // Everything after the first response, summarised from the real attempts
    // and the viewing ordinal — never a second and third quote.
    assert.strictEqual(
      artefacts[3].detail,
      '2 further contact attempts were made by email and phone, focused on progressing the viewing.',
    );
    // asked_position IS recognition. It is never described as ignored or never
    // raised — only as recognised and not progressed.
    assert.strictEqual(
      artefacts[4].detail,
      'The seller opportunity was recognised and the position was asked about,'
      + ' but it never reached a valuation or any other seller-side next step.',
    );
    assert.strictEqual(artefacts[4].tone, 'gap');
    assert.ok(!events.some((e) => e.label === 'Enquiry submitted'), 'the enquiry timestamp is on the property card, not repeated as a row');
    ok('beat 2 reads as a chronology: what was declared, what came back, what followed');

    const detected = JSON.parse(built.novus_detected_json);
    const decisions = JSON.parse(built.novus_decisions_json);
    const actions = JSON.parse(built.novus_actions_json);
    // CONTEXT -> INTELLIGENCE -> EXECUTION stays the visual signature. Each
    // stage is ONE line, because the claim being made is that NOVUS comprehends
    // the commercial context, chooses, and then executes - not that it sends
    // messages. A second bullet per stage reads as a feature list and pulls the
    // section back towards "chatbot".
    assert.deepStrictEqual(detected.map((d) => d.label), ['Understands the full situation']);
    assert.deepStrictEqual(decisions.map((d) => d.label), ['Knows the right next move']);
    assert.deepStrictEqual(actions.map((a) => a.label), ['Makes it happen']);
    ok('CONTEXT / INTELLIGENCE / EXECUTION is one claim per stage, not a feature list');

    // SCANNABLE, NOT EXPLANATORY. One short line per stage - the section has to
    // land "understands context -> decides -> acts" at a glance, and every extra
    // clause pulls it back towards a description of a chatbot.
    assert.strictEqual(
      detected[0].detail,
      'Who they are, what they want, the property, their position and what still needs to be established.',
    );
    assert.strictEqual(
      decisions[0].detail,
      'Decides what should happen next, what can be handled automatically and what needs the team.',
    );
    assert.strictEqual(
      actions[0].detail,
      // Authored with an em dash; normaliseDashes() renders it in house style.
      'Takes the next action - qualifying, following up, booking, updating, routing and escalating as needed.',
    );
    for (const stage of [detected, decisions, actions]) {
      assert.strictEqual(stage.length, 1, 'each stage is exactly one line');
      assert.ok(stage[0].detail.length <= 120, `beat 3 stays short: "${stage[0].detail}"`);
    }
    // EXECUTION is action AND routing in one line, so it carries no owner chip:
    // choosing between the two is the capability being described.
    assert.ok(actions.every((a) => !a.owner), 'EXECUTION is one line covering both paths, so no stage is labelled NOVUS or Your team');
    ok('beat 3 reads as context -> intelligence -> execution, in three short lines');

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

    for (const journey of SUPPORTED_HERO_JOURNEYS) {
      assert.strictEqual(journeySupport(journey).warning, undefined, `${journey} should be authored, not draft`);
    }
    ok('all four shell journeys are authored - none of them holds a demo at needs_review on its own');
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

    // An unreviewed journey is a review reason on its own. No journey the
    // shell currently supports produces one, so the rule is exercised with the
    // warning string a future draft journey would carry.
    const draftJourney = reviewReasonsFor(complete, { journeyWarning: 'hero_journey "future_journey" uses draft copy' });
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

    // THE HERO IS NEVER THE SHELL'S PROBLEM. A row compiled before the four
    // fixed headlines existed carries a blank demo_headline; the browser must
    // still receive the one its own stored ordinals select, because demo.html
    // has no default of its own to fall back to.
    assert.ok(rendered.demo_headline, 'a compiled row arrives with its hero title');
    const legacy = toRenderReady({ ...builtRow, demo_headline: '' });
    assert.strictEqual(legacy.demo_headline, builtRow.demo_headline);
    assert.ok(
      Object.values(HERO_TITLES).includes(legacy.demo_headline),
      'the derived hero is one of the four fixed headlines',
    );
    // Same row, one ordinal changed: the derivation reads the findings rather
    // than repeating a stored string.
    const missed = toRenderReady({ ...builtRow, demo_headline: '', human_contact: 'none' });
    assert.strictEqual(missed.demo_headline, HERO_TITLES.complete_miss);
    ok('a row with no stored hero headline is served the one its own findings select');
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
    // An incomplete story compiles, but is held at needs_review.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    // PERSONALISATION never produced the payoff sentence for this probe, so
    // beat 2 has no "so what" — the demo is compiled and flagged rather than
    // silently sent.
    store.PERSONALISATION[1][PERSONALISATION_HEADER.indexOf('commercial_consequence')] = '';
    __setRepoForTests(repo);
    const summary = await compileDemos(repo, { justPersonalised: ['prb_demo_001'], resolveImageUrl: noImage });
    assert.strictEqual(summary.demos_compiled, 1);
    assert.strictEqual(summary.demos_needs_review, 1);
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'needs_review');
    assert.ok(demoRowsOf(store)[0].review_reasons.includes('commercial_consequence'));
    assert.strictEqual(demoRowsOf(store)[0].ready_at, '', 'a demo that was never ready has no ready_at');
    ok('an incomplete story compiles to needs_review with the reason on the row');

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
    assert.ok(
      autoEvents.some((e) => e.label === 'First meaningful response' || e.label === 'Fast first response'),
      'the compiled demo carries real evidence too',
    );

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
      'demo_headline', 'demo_hook', 'positive_observation',
      'demo_reveal', 'demo_reveal_support', 'main_finding', 'commercial_consequence',
      'novus_transition', 'scale_line', 'systemic_bridge', 'cta_headline',
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
    // NOBODY ANSWERED IS ITSELF EVIDENCE. The absence is stated explicitly
    // rather than left as a hole in the page - which is what carries the
    // complete_miss journey's beat 2.
    const none = selectCommunicationEvidence({ communications: [], observationDays: 4 });
    assert.strictEqual(none.length, 1);
    assert.strictEqual(none[0].label, 'No meaningful human response');
    assert.strictEqual(
      none[0].detail,
      'No meaningful human contact was recorded by email, phone or SMS during the four-day observation period.',
    );
    assert.strictEqual(none[0].tone, 'gap');
    ok('no COMMUNICATIONS rows -> the absence is stated, with the real observation window');

    // An unknown window degrades to the honest generic phrasing, never to a
    // wrong number of days.
    assert.ok(selectCommunicationEvidence({}).at(-1).detail.includes('during the observation period.'));
    ok('an unestablished observation window degrades to generic phrasing, never a guessed one');
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
    const autoEvents = selectCommunicationEvidence({ communications: autoAckOnly, observationDays: 4 });
    assert.strictEqual(autoEvents.length, 2);
    assert.strictEqual(autoEvents[0].label, 'Automated acknowledgement');
    // THE ONE THING THIS BLOCK MAY NEVER DO is read as though somebody
    // replied: it is named automated in the label AND in the sentence, and is
    // followed by the explicit absence rather than standing in for it.
    assert.ok(autoEvents[0].detail.startsWith('An automated acknowledgement was sent by email.'));
    assert.ok(autoEvents[0].detail.endsWith('No person followed it.'));
    assert.strictEqual(autoEvents[0].tone, 'neutral');
    assert.strictEqual(autoEvents[1].label, 'No meaningful human response');
    ok('an automated acknowledgement is shown as automated, and never counted as a response');
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
      responseTime: '5 minutes', responseHours: '0.083',
    });
    assert.strictEqual(events.length, 2);
    // A MEASURED sub-hour lag is stated as fast on every journey — the label
    // is a fact about the number, not about which journey is running.
    assert.strictEqual(events[0].label, 'Fast first response');
    // THE DELAY LEADS, then THE MOST USEFUL SENTENCE — not the first few
    // words: the greeting and the thanks are scored down, the sentence that
    // shows what they actually did is the one shown, and it is a literal
    // extract, never a rewrite.
    // 09:05 UTC is 10:05 in Europe/London during BST (August).
    assert.strictEqual(
      events[0].detail,
      '5 minutes after the enquiry. "Is Saturday or Sunday any good for a viewing?" (email, 10:05)',
    );
    assert.strictEqual(events[1].label, 'What happened next');
    assert.strictEqual(events[1].detail, 'No further contact attempt was made after the first response.');
    assert.strictEqual(events[1].tone, 'gap');
    ok('a single touch leads with the measured lag, then the useful sentence, then an explicit "no further attempts"');

    // A lag over the hour is NOT dressed up as fast.
    const slow = selectCommunicationEvidence({
      communications: oneTouch, responseTime: '17.9 hours', responseHours: '17.85',
    });
    assert.strictEqual(slow[0].label, 'First meaningful response');
    assert.ok(slow[0].detail.startsWith('17.9 hours after the enquiry.'));
    ok('a lag over an hour is labelled plainly, with the delay stated first');

    // An automated acknowledgement before that human touch belongs in the
    // same first-response evidence. It is credited without being mistaken for
    // the meaningful response measured by response_hours.
    const acknowledged = selectCommunicationEvidence({
      communications: [
        {
          communication_id: 'a1', probe_id: 'p', occurred_at: '2026-08-01T09:01:00.000Z',
          channel: 'email', automated_or_human: 'automated',
          communication_classification: 'auto_acknowledgement',
          body_text: 'Thanks for your enquiry. A member of the team will get back to you.',
        },
        { ...oneTouch[0], occurred_at: '2026-08-04T09:00:00.000Z' },
      ],
      enquiryAt: '2026-08-01T09:00:00.000Z', responseTime: '3 days', responseHours: '72',
    });
    assert.strictEqual(acknowledged[0].label, 'First meaningful response');
    assert.ok(acknowledged[0].detail.startsWith('An automated email was sent straight away saying'));
    assert.ok(acknowledged[0].detail.includes('"Thanks for your enquiry. A member of the team will get back to you."'));
    assert.ok(acknowledged[0].detail.includes('The first meaningful human response came 3 days after the enquiry.'));
    ok('a preceding automated acknowledgement is credited inside the first-response evidence');

    const multipleAcknowledgements = selectCommunicationEvidence({
      communications: [
        {
          communication_id: 'a1', probe_id: 'p', occurred_at: '2026-08-01T09:01:00.000Z',
          channel: 'email', automated_or_human: 'automated', body_text: 'We have received your enquiry.',
        },
        {
          communication_id: 'a2', probe_id: 'p', occurred_at: '2026-08-01T09:03:00.000Z',
          channel: 'sms', automated_or_human: 'automated', body_text: 'The team will get back to you.',
        },
        { ...oneTouch[0], occurred_at: '2026-08-04T09:00:00.000Z' },
      ],
      responseTime: '3 days', responseHours: '72',
    });
    assert.ok(multipleAcknowledgements[0].detail.startsWith(
      'Automated messages by email and SMS acknowledged the enquiry. The first meaningful human response came 3 days after the enquiry.',
    ));
    assert.ok(!multipleAcknowledgements[0].detail.includes('We have received your enquiry'));
    ok('multiple automated messages are summarised rather than listed');
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
    assert.strictEqual(events[0].label, 'First meaningful response');
    assert.ok(events[0].detail.startsWith('"Happy to arrange a viewing whenever suits you."'));
    assert.strictEqual(
      events[1].detail,
      '2 further contact attempts were made by phone and SMS, focused on progressing the viewing.',
    );
    // The seller finding is its own block now, never a clause bolted onto the
    // end of the follow-up sentence.
    assert.ok(!/seller/i.test(events[1].detail));
    ok('the remaining attempts are summarised by count, channel and what they were for');

    // An unanswered call as the FIRST touch is stated as exactly that —
    // no transcript excerpt, no attribution tag.
    const firstIsVoicemail = [
      { communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-01T09:00:00.000Z', channel: 'voice', automated_or_human: 'human', voicemail_present: 'TRUE', transcript: 'Hi, calling about the enquiry.' },
      { communication_id: 'c2', probe_id: 'p', occurred_at: '2026-08-01T09:05:00.000Z', channel: 'email', automated_or_human: 'human', body_text: 'Following up my call by email.' },
    ];
    const events2 = selectCommunicationEvidence({ communications: firstIsVoicemail });
    assert.strictEqual(events2[0].detail, 'Voicemail left.');
    const events3 = selectCommunicationEvidence({ communications: firstIsVoicemail, responseTime: '2 hours', responseHours: '2' });
    assert.strictEqual(events3[0].detail, '2 hours after the enquiry. Voicemail left.');
    ok('an unanswered first call reads simply as "Voicemail left.", behind the measured lag');
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
    ok('the follow-up beat reports the attempts and nothing else');
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
    assert.ok(events.some((e) => e.kind === 'metric' && e.label === '2 contact attempts' && e.detail === 'phone and email'));
    // No matched message means no quoted artefact — but the absence of a human
    // response is still stated, because it is the finding.
    assert.ok(!events.some((e) => String(e.label).includes('First meaningful response')));
    assert.ok(events.some((e) => e.label === 'No meaningful human response'));
    ok('with no matched COMMUNICATIONS the metric strip stands and the absence is named');

    // A probe that never declared a seller carries no seller metrics at all —
    // "2 opportunities" and "No valuation progression" would both be untrue,
    // and no SELLER OPPORTUNITY block is written either.
    assert.ok(!events.some((e) => e.label === '2 opportunities'));
    assert.ok(!events.some((e) => e.label === 'No valuation progression'));
    assert.ok(!events.some((e) => e.label === 'Seller opportunity'));

    // THE CHRONOLOGY, in one fixed order, whichever journey is running: what
    // was sent, what came back, what it achieved on the buying side, how hard
    // the team kept going, and what became of the declared vendor.
    const full = buildObservedEvents({
      intelligence: {
        contact_attempts: '3', channels_used: 'voice,email', response_hours: '17.85',
        viewing_progression: 'slot_offered', seller_recognition: 'asked_position',
      },
      sellerDeclared: true,
      sellerDeclarationText: 'Declared: has a property to sell, not yet on the market',
      responseTime: '17.9 hours',
      propertyAddress: 'Barn Field, Chevington',
      enquiryDate: '17 August',
      enquiryTime: '23:34',
      observationDays: 4,
      communications: [
        { communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-18T16:30:00.000Z', channel: 'email', automated_or_human: 'human', body_text: 'Thanks for your enquiry. Would Saturday suit you for a viewing?' },
        { communication_id: 'c2', probe_id: 'p', occurred_at: '2026-08-19T09:00:00.000Z', channel: 'voice', automated_or_human: 'human', transcript: 'Just chasing the viewing.' },
      ],
    });
    assert.deepStrictEqual(
      full.filter((e) => e.kind === 'evidence').map((e) => e.label),
      ['Enquiry sent', 'First meaningful response', 'Buyer / viewing progression', 'What happened next', 'Seller opportunity'],
    );
    assert.ok(full.find((e) => e.label === 'Enquiry sent').detail
      .startsWith('Barn Field, Chevington, 17 August at 23:34.'));
    // CREDIT WHERE IT IS DUE, THEN THE CONTRAST: the buyer side is stated as a
    // good outcome, the recognised-but-unprogressed vendor as the gap.
    const viewing = full.find((e) => e.label === 'Buyer / viewing progression');
    assert.strictEqual(viewing.detail, 'A specific viewing slot was offered.');
    assert.strictEqual(viewing.tone, 'good');
    const seller = full.find((e) => e.label === 'Seller opportunity');
    assert.strictEqual(seller.tone, 'gap');
    assert.ok(/recognised/i.test(seller.detail), 'asked_position is recognition, never a miss');
    assert.ok(!/never (raised|acknowledged)/i.test(seller.detail));
    ok('the evidence reads as one fixed chronology, crediting the buyer side before naming the seller gap');

    // Nothing established at all: no attempts, no ordinals, no messages, no
    // property. Only the absence itself, which is honest.
    assert.deepStrictEqual(
      buildObservedEvents({ intelligence: {}, sellerDeclared: false, communications: [] })
        .map((e) => e.label),
      ['No meaningful human response'],
    );
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

  // ══ Part Q — the four journeys, and personalisation INSIDE each one ═══════
  //
  // ONE ROUTE, ONE SHELL, FOUR STORIES. /demo/{slug} resolves the agency's own
  // row and renders whatever hero_journey selected — there is no second URL
  // and no hand-assigned page. These checks prove two separate things:
  //
  //   1. the SAME probe, told under four different hero_journeys, produces
  //      four genuinely different narratives (not one template with a word
  //      swapped), and
  //   2. WITHIN one journey, the copy still changes with that probe's own
  //      evidence — the seller declaration, seller_recognition,
  //      viewing_progression, the measured delay and the follow-up count.
  console.log('\nPart Q — four journeys through one route, personalised inside each');

  // One helper, so a case is a line of evidence rather than a fixture.
  const journeyRow = ({
    heroJourney, sellerDeclared = true, sellerRecognition = 'none',
    viewingProgression = 'none', responseHours = '0.38', contactAttempts = '1',
    followUps = '0', humanContact = 'yes', communications = [],
  }) => buildDemoRow({
    probe: {
      probe_id: 'p', agency_id: 'a', probe_reference: 'RM-1',
      property_address: 'Barn Field, Chevington', property_price: '£375,000',
      enquiry_text: sellerDeclared ? SELLER_DECLARATION : 'Interested in viewing this property.',
      probe_timestamp: '2026-08-17T22:34:41.000Z',
    },
    agency: { agency_name: 'Ensum Brown' },
    intelligence: {
      human_contact: humanContact, response_hours: responseHours,
      contact_attempts: contactAttempts, follow_ups: followUps, channels_used: 'email',
      viewing_progression: viewingProgression,
      seller_recognition: sellerDeclared ? sellerRecognition : '',
    },
    findings: [],
    personalisation: {
      hero_journey: heroJourney,
      primary_narrative: 'x',
      commercial_consequence: 'the opportunity never reached a next step.',
      fair_observation: humanContact === 'yes' ? 'you did reply.' : '',
    },
    communications,
    demoSlug: 'ensum-brown-rm-1',
  }).row;

  {
    // ── 1. FOUR DISTINCT STORIES FROM ONE ROUTE ──
    const shared = { sellerDeclared: true, sellerRecognition: 'none', viewingProgression: 'none' };
    const rows = Object.fromEntries(
      SUPPORTED_HERO_JOURNEYS.map((j) => [j, journeyRow({ ...shared, heroJourney: j })]),
    );
    for (const [journey, r] of Object.entries(rows)) {
      assert.strictEqual(r.hero_journey, journey);
    }
    // Every journey tells the story in its own words: no two share a hero,
    // a conclusion or a scale line.
    for (const field of ['demo_hook', 'demo_reveal']) {
      const values = Object.values(rows).map((r) => r[field]);
      assert.strictEqual(new Set(values).size, values.length, `${field} must differ between journeys`);
    }
    ok('the same probe under four hero_journeys produces four different narratives, not one template');

    // The brief's own transition and scale lines, per journey. Blank on
    // weak_seller_qualification, which keeps the shell's defaults.
    assert.strictEqual(rows.slow_response_gap.novus_transition, 'Same enquiry. NOVUS acts while the opportunity is still live.');
    assert.strictEqual(rows.fast_response_stalled_follow_up.novus_transition, 'Same enquiry. NOVUS keeps the opportunity moving.');
    assert.strictEqual(rows.complete_miss.novus_transition, 'Same enquiry. NOVUS turns arrival into action.');
    assert.ok(rows.slow_response_gap.scale_line.startsWith("The value isn't shaving a few hours off one enquiry."));
    assert.ok(rows.fast_response_stalled_follow_up.scale_line.startsWith("The value isn't one extra follow-up."));
    assert.ok(rows.complete_miss.scale_line.startsWith("The value isn't rescuing one missed enquiry."));
    assert.strictEqual(rows.weak_seller_qualification.novus_transition, '');
    assert.strictEqual(rows.weak_seller_qualification.scale_line, '');
    ok('each new journey carries its own NOVUS transition and scale line; the reference journey keeps the shell defaults');

    // EVERY JOURNEY WRITES A HERO ONTO THE ROW, and it is always one of the
    // four fixed lines. The hero follows the FINDINGS, not the journey name -
    // these four rows share one set of findings (a declared vendor nobody
    // progressed), so the three that reached a human all open on the seller
    // line and only complete_miss differs.
    const headlines = Object.values(rows).map((r) => r.demo_headline);
    assert.ok(headlines.every((h) => h), 'every journey writes a hero title onto the row');
    assert.ok(
      headlines.every((h) => Object.values(HERO_TITLES).includes(h)),
      'every hero is one of the four fixed headlines',
    );
    assert.strictEqual(rows.complete_miss.demo_headline, HERO_TITLES.complete_miss);
    for (const journey of ['slow_response_gap', 'fast_response_stalled_follow_up', 'weak_seller_qualification']) {
      assert.strictEqual(rows[journey].demo_headline, HERO_TITLES.seller_unprogressed, journey);
    }
    assert.ok(
      !headlines.some((h) => /More than one opportunity/i.test(h)),
      'the hard-coded global headline is never what a compiled demo shows',
    );
    ok('the hero title is one of the four fixed headlines, chosen from the findings rather than the journey name');
  }

  {
    // ── 2. slow_response_gap: the seller finding shares the hero ──
    // The hero_journey names the PRIMARY story, but an unprogressed declared
    // vendor is the commercially larger finding and is never buried behind it.
    const withSeller = journeyRow({
      heroJourney: 'slow_response_gap', sellerRecognition: 'none',
      viewingProgression: 'invited', responseHours: '17.85',
    });
    // The buyer side genuinely moved, so it is credited - and the finding the
    // agency should read first is the vendor, not the 17.9-hour delay.
    assert.strictEqual(withSeller.demo_headline, HERO_TITLES.seller_unprogressed);
    assert.ok(withSeller.demo_hook.includes('17.9 hours'), 'the measured delay is still stated, as evidence');
    assert.ok(!/17\.9 hours/.test(withSeller.demo_headline), 'the delay is not the hero when a vendor went unworked');
    assert.ok(withSeller.demo_hook.includes('never progressed'));
    assert.strictEqual(withSeller.demo_reveal, 'The buyer waited - and the potential vendor was never meaningfully progressed.');

    // Same journey, same delay — but the vendor WAS recognised. The conclusion
    // changes to match the evidence, and never claims it was missed.
    const recognised = journeyRow({
      heroJourney: 'slow_response_gap', sellerRecognition: 'asked_position',
      viewingProgression: 'invited', responseHours: '17.85',
    });
    assert.strictEqual(
      recognised.demo_reveal,
      'The seller opportunity was recognised, and it still never reached a meaningful seller-side next step.',
    );

    // Same journey again, with the vendor genuinely converted: a pure
    // response-speed story, with no seller claim in it at all.
    const noSellerGap = journeyRow({
      heroJourney: 'slow_response_gap', sellerRecognition: 'valuation_offered',
      viewingProgression: 'slot_offered', responseHours: '17.85',
      contactAttempts: '3', followUps: '2',
    });
    assert.strictEqual(noSellerGap.demo_headline, HERO_TITLES.slow_response);
    assert.strictEqual(noSellerGap.demo_reveal, 'The opportunity was worked. Just later than it needed to be.');
    assert.ok(!/vendor|seller/i.test(noSellerGap.demo_hook + noSellerGap.demo_reveal));
    ok('slow_response_gap carries the seller finding into the hero when there is one, and drops it entirely when there is not');
  }

  {
    // ── 3. fast_response_stalled_follow_up: credit, then contrast ──
    // A buyer side that genuinely moved is stated as such — that contrast IS
    // the finding, and it is what stops the demo reading as an attack.
    const contrast = journeyRow({
      heroJourney: 'fast_response_stalled_follow_up', sellerRecognition: 'asked_position',
      viewingProgression: 'slot_offered', responseHours: '0.38', contactAttempts: '2', followUps: '1',
    });
    assert.strictEqual(contrast.demo_headline, HERO_TITLES.seller_unprogressed);
    assert.ok(contrast.demo_hook.includes('in 23 minutes'), 'the speed claim is the measured one');
    assert.strictEqual(contrast.demo_reveal, "The viewing was actively progressed. The potential vendor wasn't.");

    // A buyer side that never moved cannot be credited with progression.
    const neither = journeyRow({
      heroJourney: 'fast_response_stalled_follow_up', sellerRecognition: 'none',
      viewingProgression: 'mentioned', responseHours: '0.38',
    });
    assert.strictEqual(neither.demo_reveal, 'The enquiry was answered. Neither opportunity was fully progressed.');

    // No seller in the enquiry at all: a pure follow-through story.
    const buyerOnly = journeyRow({
      heroJourney: 'fast_response_stalled_follow_up', sellerDeclared: false,
      viewingProgression: 'invited', responseHours: '0.38',
    });
    assert.strictEqual(buyerOnly.demo_headline, HERO_TITLES.stalled_progression);
    assert.strictEqual(buyerOnly.demo_reveal, "The enquiry was answered. It wasn't completed.");
    assert.ok(!/vendor|seller/i.test(buyerOnly.demo_hook + buyerOnly.demo_reveal + buyerOnly.demo_headline));
    ok('fast_response_stalled_follow_up credits the buyer progression, then contrasts it against the vendor');

    // The follow-up evidence lives in beat 2, where the rest of the evidence
    // is - beat 3 is the product claim and stays three short lines. A single
    // unanswered touch and a real second attempt read differently.
    const eventsNone = JSON.parse(neither.observed_events_json).filter((e) => e.kind === 'metric');
    assert.ok(eventsNone.some((e) => e.label === '1 contact attempt'));
    const eventsSome = JSON.parse(contrast.observed_events_json).filter((e) => e.kind === 'metric');
    assert.ok(eventsSome.some((e) => e.label === '2 contact attempts'));
    ok('the real contact-attempt count is reported in the evidence, not glossed over');
  }

  {
    // ── 4. complete_miss: the hardest story, still strictly factual ──
    const both = journeyRow({
      heroJourney: 'complete_miss', sellerDeclared: true, sellerRecognition: 'none',
      humanContact: 'none', responseHours: '', contactAttempts: '0',
      communications: [{
        communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-17T22:35:00.000Z',
        channel: 'email', automated_or_human: 'automated',
        communication_classification: 'auto_acknowledgement',
        body_text: 'Thank you for your enquiry. A member of the team will be in touch shortly.',
      }],
    });
    assert.strictEqual(both.demo_headline, HERO_TITLES.complete_miss);
    assert.strictEqual(both.demo_reveal, "The buyer wasn't progressed. The potential vendor wasn't either.");
    assert.strictEqual(
      both.demo_reveal_support,
      'Two commercial opportunities entered the business in one enquiry and neither reached a meaningful next step.',
    );

    // AN AUTOMATED ACKNOWLEDGEMENT IS NEVER A RESPONSE. It is shown, labelled
    // as automated, and the absence of a human one is stated separately.
    const missEvents = JSON.parse(both.observed_events_json);
    const labels = missEvents.filter((e) => e.kind === 'evidence').map((e) => e.label);
    assert.deepStrictEqual(labels, [
      'Enquiry sent', 'Automated acknowledgement', 'No meaningful human response',
      'Buyer / viewing progression', 'Seller opportunity',
    ]);
    assert.ok(!labels.some((l) => l.includes('First meaningful response')));
    assert.ok(missEvents.find((e) => e.label === 'No meaningful human response').detail
      .includes('four-day observation period'));

    // No declared vendor: the shorter, quieter story, with no vendor claim.
    const buyerOnly = journeyRow({ heroJourney: 'complete_miss', sellerDeclared: false, humanContact: 'none', responseHours: '', contactAttempts: '0' });
    assert.strictEqual(buyerOnly.demo_headline, HERO_TITLES.complete_miss);
    assert.strictEqual(buyerOnly.demo_reveal, 'The opportunity simply sat there.');
    assert.strictEqual(buyerOnly.demo_reveal_support, '');
    ok('complete_miss separates the automated acknowledgement from the absent human response, and drops the vendor story when there was none');
  }

  {
    // ── 5. asked_position IS RECOGNITION, EVERYWHERE ──
    // The one claim these journeys may never make about a probe whose agency
    // did ask about the seller position.
    for (const journey of SUPPORTED_HERO_JOURNEYS) {
      const r = journeyRow({ heroJourney: journey, sellerRecognition: 'asked_position', viewingProgression: 'slot_offered' });
      const copy = [
        r.demo_headline, r.demo_hook, r.demo_reveal, r.demo_reveal_support,
        r.observed_events_json, r.novus_detected_json, r.novus_decisions_json, r.novus_actions_json,
      ].join(' ');
      assert.ok(
        !/(never (recognised|acknowledged|raised|mentioned)|completely missed|ignored)/i.test(copy),
        `${journey} must never call a recognised seller position a miss`,
      );
      // And no journey ever asserts an instruction that was never won.
      assert.ok(!/missed instruction|lost instruction/i.test(copy), `${journey} must not assert a lost instruction`);
    }
    ok('no journey describes an asked-about seller position as ignored, missed or never recognised');

    // The same rule the other way round: where it genuinely was never raised,
    // the demo says so rather than softening it into recognition.
    const neverRaised = journeyRow({ heroJourney: 'slow_response_gap', sellerRecognition: 'none' });
    assert.ok(JSON.parse(neverRaised.observed_events_json)
      .some((e) => e.label === 'Seller opportunity' && /never acknowledged or explored/i.test(e.detail)));
    ok('a seller opportunity that genuinely was never raised is still stated plainly');
  }

  {
    // ── 6. THE ROUTE FAILS SAFE ──
    // A blank or unknown hero_journey never falls through to another journey's
    // narrative: no row is compiled at all, so the slug resolves to nothing.
    for (const journey of ['', 'not_a_journey', 'automated_ack_only']) {
      assert.throws(
        () => journeyRow({ heroJourney: journey }),
        (err) => err.code === 'unsupported_hero_journey',
        `hero_journey "${journey}" must be refused, never rendered as another journey`,
      );
    }
    ok('a missing or invalid hero_journey fails safely instead of silently showing the wrong journey');
  }


  // ══ Part R — the hero is the strongest FINDING, not the journey name ══════
  //
  // hero_journey is an operational label picked upstream from human_contact
  // and the grading engine's own response bands. What the agency should read
  // FIRST is a commercial question, and these checks are the whole of the
  // answer: the title changes with the evidence, and a modest delay never
  // outranks an unworked vendor or an unfinished opportunity.
  console.log('\nPart R — hero titles come from the findings, in commercial priority order');

  {
    // ── 1. THE MATRIX ──
    // One case per shape the four journeys can actually produce, each mapped
    // to the commercial priority its ordinals establish - and from there to
    // one of the four fixed headlines. The point of this table is that the
    // SELECTION is driven by the findings: a seller opportunity being present
    // does not win the hero on its own (cases 7-9 all carry one), and the
    // journey name never picks the line (cases 1, 3 and 5 are three different
    // journeys landing on the same finding).
    const cases = [
      ['weak_seller_qualification, seller never raised',
        { heroJourney: 'weak_seller_qualification', sellerRecognition: 'none', viewingProgression: 'slot_offered' },
        'seller_unprogressed'],
      ['weak_seller_qualification, seller position asked about but never progressed',
        { heroJourney: 'weak_seller_qualification', sellerRecognition: 'asked_position', viewingProgression: 'slot_offered' },
        'seller_unprogressed'],
      ['fast response, vendor left unworked',
        { heroJourney: 'fast_response_stalled_follow_up', sellerRecognition: 'none', viewingProgression: 'invited' },
        'seller_unprogressed'],
      ['fast response, no vendor in the enquiry',
        { heroJourney: 'fast_response_stalled_follow_up', sellerDeclared: false, viewingProgression: 'invited' },
        'stalled_progression'],
      ['slow response, buyer handled, vendor not',
        { heroJourney: 'slow_response_gap', sellerRecognition: 'none', viewingProgression: 'slot_offered', responseHours: '17.85' },
        'seller_unprogressed'],
      ['slow response, neither side progressed',
        { heroJourney: 'slow_response_gap', sellerRecognition: 'none', viewingProgression: 'none', responseHours: '16.1' },
        'seller_unprogressed'],
      ['a genuinely severe delay, well handled after it',
        { heroJourney: 'slow_response_gap', sellerDeclared: false, viewingProgression: 'booked', responseHours: '52', contactAttempts: '3', followUps: '2' },
        'slow_response'],
      ['complete miss, two opportunities',
        { heroJourney: 'complete_miss', humanContact: 'none', responseHours: '', contactAttempts: '0' },
        'complete_miss'],
      ['complete miss, buyer only',
        { heroJourney: 'complete_miss', sellerDeclared: false, humanContact: 'none', responseHours: '', contactAttempts: '0' },
        'complete_miss'],
    ];
    const seen = new Set();
    for (const [name, evidence, expectedPriority] of cases) {
      const built = journeyRow(evidence);
      assert.strictEqual(built.demo_headline, HERO_TITLES[expectedPriority], `hero title for ${name}`);
      seen.add(built.demo_headline);
    }
    // All four lines are reachable, and nothing outside the four is ever
    // written onto a row.
    assert.strictEqual(seen.size, 4, 'all four fixed headlines are reachable from real findings');
    assert.deepStrictEqual([...seen].sort(), Object.values(HERO_TITLES).sort());
    ok(`${cases.length} sets of findings select between the four fixed hero titles, and reach all four`);

    // A DECLARED VENDOR DOES NOT AUTOMATICALLY WIN THE HERO. Same seller gap
    // in all three, three different strongest findings.
    assert.strictEqual(
      journeyRow({ heroJourney: 'complete_miss', sellerRecognition: 'none', humanContact: 'none', responseHours: '', contactAttempts: '0' }).demo_headline,
      HERO_TITLES.complete_miss,
      'a complete miss outranks the seller line even with a declared vendor',
    );
    ok('the seller headline is used only where the unworked vendor is the strongest finding');

    // The old hard-coded global headline is gone from every one of them.
    for (const [, evidence] of cases) {
      const built = journeyRow(evidence);
      assert.ok(
        !/More than one opportunity/i.test(built.demo_headline),
        'no demo falls back to the shell\'s global headline',
      );
    }
    ok('no compiled demo shows "One enquiry. More than one opportunity." any more');
  }

  {
    // ── 2. COMMERCIAL PRIORITY ──
    // The brief's own example: replied after 16.1 hours, one voicemail, no
    // follow-up, no viewing progression, a declared vendor nobody touched.
    // The 16.1 hours is NOT the story. Two opportunities that went nowhere is.
    const evidence = {
      heroJourney: 'slow_response_gap', sellerRecognition: 'none',
      viewingProgression: 'none', responseHours: '16.1', contactAttempts: '1', followUps: '0',
      // The one touch the brief's example describes: a single voicemail.
      communications: [{
        communication_id: 'c1', probe_id: 'p', occurred_at: '2026-08-18T14:40:41.000Z',
        channel: 'voice', direction: 'outbound', automated_or_human: 'human',
        voicemail_present: 'TRUE', transcript: 'Hi, calling about your enquiry. Give us a call back.',
      }],
    };
    const built = journeyRow(evidence);
    const ctx = {
      sellerDeclared: true,
      intelligence: {
        human_contact: 'yes', response_hours: '16.1', contact_attempts: '1',
        follow_ups: '0', viewing_progression: 'none', seller_recognition: 'none',
      },
    };
    assert.strictEqual(commercialPriority('slow_response_gap', ctx), 'seller_unprogressed');
    assert.strictEqual(built.demo_headline, HERO_TITLES.seller_unprogressed);
    assert.ok(!/16\.1|hour/i.test(built.demo_headline), 'the measured delay is not the hero here');
    ok('a 16.1-hour reply with an unworked vendor leads on the two opportunities, not on the delay');

    // AND THE DELAY IS STILL THERE. It moves into the evidence - the hook and
    // the observed events - rather than disappearing.
    assert.ok(built.demo_hook.includes('16.1 hours'), 'the hook still states the measured delay');
    const firstResponse = JSON.parse(built.observed_events_json)
      .find((e) => /response/i.test(e.label) && e.kind === 'evidence');
    assert.ok(firstResponse.detail.includes('16.1 hours'), `the evidence still carries the measured delay: ${firstResponse.detail}`);
    assert.ok(firstResponse.detail.includes('Voicemail left.'));
    assert.strictEqual(built.response_time, '16.1 hours');
    ok('the delay and the single voicemail still appear in the hook and the observed events');

    // A MODEST DELAY NEVER OUTRANKS AN UNFINISHED OPPORTUNITY. 17.85 hours is
    // over the grading engine's internal 16-hour Fast/Slow line - which is
    // exactly the threshold a prospect has no reason to care about.
    const modest = journeyRow({
      heroJourney: 'slow_response_gap', sellerDeclared: false,
      viewingProgression: 'slot_offered', responseHours: '17.85', contactAttempts: '1', followUps: '0',
    });
    assert.strictEqual(modest.demo_headline, HERO_TITLES.stalled_progression);
    assert.ok(modest.demo_hook.includes('17.9 hours'), 'the delay is still evidence on this one too');
    ok('a modest delay just past the internal 16-hour line does not take the hero from a stalled opportunity');

    // The delay leads only when it is severe on its own terms AND nothing
    // above it in the priority order is true.
    const severe = journeyRow({
      heroJourney: 'slow_response_gap', sellerDeclared: false,
      viewingProgression: 'booked', responseHours: '52', contactAttempts: '3', followUps: '2',
    });
    assert.strictEqual(severe.demo_headline, HERO_TITLES.slow_response);
    ok('a genuinely severe delay, with nothing bigger alongside it, still leads the demo');

    // The full ladder, one probe at a time: each stronger finding takes the
    // hero from the one below it.
    const base = { heroJourney: 'slow_response_gap', responseHours: '52', contactAttempts: '3', followUps: '2', viewingProgression: 'booked' };
    const ladder = [
      [{ ...base, sellerDeclared: false }, 'slow_response'],
      [{ ...base, sellerDeclared: false, viewingProgression: 'none' }, 'slow_response'],
      [{ ...base, sellerRecognition: 'none' }, 'seller_unprogressed'],
      [{ ...base, sellerRecognition: 'none', humanContact: 'none' }, 'complete_miss'],
    ];
    for (const [evidenceRow, expectedPriority] of ladder) {
      const ctxRow = {
        sellerDeclared: evidenceRow.sellerDeclared !== false,
        intelligence: {
          human_contact: evidenceRow.humanContact || 'yes',
          response_hours: evidenceRow.responseHours,
          contact_attempts: evidenceRow.contactAttempts,
          follow_ups: evidenceRow.followUps,
          viewing_progression: evidenceRow.viewingProgression,
          seller_recognition: evidenceRow.sellerDeclared === false ? '' : (evidenceRow.sellerRecognition || 'none'),
        },
      };
      assert.strictEqual(commercialPriority(evidenceRow.heroJourney, ctxRow), expectedPriority);
      assert.strictEqual(heroTitle(evidenceRow.heroJourney, ctxRow), journeyRow(evidenceRow).demo_headline);
    }
    ok('complete miss > unprogressed seller > stalled progression > slow response, on the same probe');
  }

  // ══ Part S — every campaign-ready link actually resolves ══════════════════
  //
  // A demo that 404s is invisible from the inside: the row still says `ready`
  // and the slug still looks right. These checks cover the three ways that
  // happens - the slug does not survive the round trip, the row's own status
  // gate refuses it, or the row was never written at all - and the audit that
  // finds all three in one call.
  console.log('\nPart S — auditing every demo slug through the real route');

  {
    // ── 1. THE SLUG SURVIVES THE ROUND TRIP ──
    // Everything a slug picks up between a sheet cell and a path segment.
    assert.strictEqual(normaliseSlug('  Ensum-Brown-RM-0042  '), 'ensum-brown-rm-0042');
    assert.strictEqual(normaliseSlug('/demo-slug/'), 'demo-slug');
    assert.strictEqual(normaliseSlug('ensum brown'), 'ensumbrown');
    assert.strictEqual(normaliseSlug('slug​'), 'slug');
    assert.strictEqual(normaliseSlug(''), '');
    ok('a slug with stray whitespace, a pasted trailing slash or a different case resolves to the same demo');

    // ── 2. THE STATUS GATE CANNOT SILENTLY RETIRE A GOOD LINK ──
    const table = {
      header: ['demo_slug', 'demo_status', 'review_reasons'],
      rows: [
        ['ready-demo', 'ready', ''],
        ['blank-status-demo', '', ''],
        ['typo-status-demo', 'Ready ', ''],
        ['unfinished-demo', '', 'commercial_consequence is blank'],
        ['retired-demo', 'archived', ''],
      ],
    };
    assert.strictEqual(effectiveDemoStatus({ demo_status: '', review_reasons: '' }), 'ready');
    assert.strictEqual(effectiveDemoStatus({ demo_status: '', review_reasons: 'x' }), 'needs_review');
    assert.strictEqual(resolveDemoBySlug(table, 'blank-status-demo').ok, true);
    assert.strictEqual(resolveDemoBySlug(table, 'typo-status-demo').ok, true);
    assert.strictEqual(resolveDemoBySlug(table, 'unfinished-demo').ok, false);
    assert.strictEqual(resolveDemoBySlug(table, 'unfinished-demo', { preview: true }).ok, true);
    assert.strictEqual(resolveDemoBySlug(table, 'retired-demo', { preview: true }).ok, false);
    assert.strictEqual(resolveDemoBySlug(table, 'nothing-here').ok, false);
    ok('a hand-blanked or mistyped demo_status re-derives from the row rather than 404ing the link');
  }

  {
    // ── 3. THE AUDIT, OVER A WHOLE WORKBOOK ──
    // Four demos in the shapes that actually occur: one sendable, one whose
    // slug carries a stray space, one held at needs_review, one archived —
    // plus a personalised probe whose demo row was never written.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store, { propertyUrl: '' });
    seedWeakSeller(store, {
      probeId: 'prb_demo_002', probeReference: 'RM-0043',
      agencyId: 'agc_two', agencyName: 'Second Agency', propertyUrl: '',
    });
    seedWeakSeller(store, {
      probeId: 'prb_demo_003', probeReference: 'RM-0044',
      agencyId: 'agc_three', agencyName: 'Third Agency', propertyUrl: '',
    });
    seedWeakSeller(store, {
      probeId: 'prb_demo_004', probeReference: 'RM-0045',
      agencyId: 'agc_four', agencyName: 'Fourth Agency', propertyUrl: '',
    });
    // prb_demo_005 is personalised and has no DEMOS row at all — the failure
    // a per-slug check can never see, because there is no slug to check.
    seedWeakSeller(store, {
      probeId: 'prb_demo_005', probeReference: 'RM-0046',
      agencyId: 'agc_five', agencyName: 'Fifth Agency', propertyUrl: '',
    });
    // The third demo never got its payoff sentence, so it compiles to
    // needs_review and 404s for a prospect.
    store.PERSONALISATION[3][PERSONALISATION_HEADER.indexOf('commercial_consequence')] = '';
    __setRepoForTests(repo);

    await compileDemos(repo, {
      probeIds: ['prb_demo_001', 'prb_demo_002', 'prb_demo_003', 'prb_demo_004'],
      force: true,
      resolveImageUrl: noImage,
    });
    assert.strictEqual(demoRowsOf(store).length, 4);

    // A slug that picked up a trailing space on its way into the sheet.
    const slugIdx = DEMOS_HEADER.indexOf('demo_slug');
    const spaced = store.DEMOS.find((r) => r[slugIdx] === 'second-agency-rm-0043');
    spaced[slugIdx] = 'second-agency-rm-0043 ';
    // And one whose status cell was cleared by hand.
    store.DEMOS.find((r) => r[slugIdx] === 'fourth-agency-rm-0045')[DEMOS_HEADER.indexOf('demo_status')] = '';
    // The fourth is deliberately retired.
    await demoHandler(mockReq({ body: { action: 'archive', probe_id: 'prb_demo_001' } }), mockRes());

    const auditRes = mockRes();
    await demoHandler(mockReq({ body: { action: 'audit' } }), auditRes);
    assert.strictEqual(auditRes.statusCode, 200, JSON.stringify(auditRes.body));
    const audit = auditRes.body;
    assert.strictEqual(audit.tested, 4);
    assert.strictEqual(audit.working, 2, JSON.stringify(audit.demos, null, 2));
    assert.strictEqual(audit.broken, 2);
    assert.deepStrictEqual(audit.missing_demo_rows, ['prb_demo_005']);
    ok('the audit tests every slug in DEMOS and names the personalised probe that has no row at all');

    // A slug with a stray space still resolves — it is the same demo.
    assert.ok(audit.demos.find((d) => d.demo_slug.trim() === 'second-agency-rm-0043').resolves);
    // A row whose status cell was blanked resolves on its own review_reasons.
    const healed = audit.demos.find((d) => d.demo_slug === 'fourth-agency-rm-0045');
    assert.strictEqual(healed.demo_status, '');
    assert.strictEqual(healed.effective_status, 'ready');
    assert.ok(healed.resolves);
    ok('a stray space in the cell and a blanked status cell are both resolved, not reported as dead links');

    // THE AUDIT CANNOT DISAGREE WITH THE ROUTE. Every verdict is checked
    // against a real anonymous GET of that slug.
    for (const demo of audit.demos) {
      const res = mockRes();
      await demoHandler(mockReq({ method: 'GET', query: { slug: demo.demo_slug }, auth: false }), res);
      assert.strictEqual(
        res.statusCode === 200, demo.resolves,
        `${demo.demo_slug}: audit says ${demo.resolves}, the route says ${res.statusCode}`,
      );
    }
    ok('every audit verdict matches what a real prospect request to that slug returns');

    // A BROKEN DEMO IS NEVER SILENTLY CAMPAIGN-READY. Each one says why.
    for (const demo of audit.demos.filter((d) => !d.resolves)) {
      assert.ok(demo.reason, `${demo.demo_slug} must say why it does not resolve`);
    }
    const unfinished = audit.demos.find((d) => d.demo_slug === 'third-agency-rm-0044');
    assert.ok(unfinished.reason.includes('commercial_consequence'));
    ok('every broken demo carries the reason it cannot be sent');

    // ── 4. --fix REPAIRS THROUGH THE COMPILER, NEVER BY PATCHING A URL ──
    // The missing row is compiled; the archived one stays archived (retiring
    // is deliberate); the unfinished one is still unfinished and says so.
    const fixRes = mockRes();
    await demoHandler(mockReq({ body: { action: 'audit', fix: true } }), fixRes);
    const fixed = fixRes.body;
    assert.strictEqual(fixed.tested, 5, 'the missing demo row was written by the compiler');
    assert.deepStrictEqual(fixed.missing_demo_rows, []);
    assert.ok(fixed.working >= 3, JSON.stringify(fixed.demos.map((d) => [d.demo_slug, d.resolves])));
    assert.strictEqual(
      fixed.demos.find((d) => d.demo_slug === 'ensum-brown-rm-0042').effective_status, 'archived',
      'a deliberately retired demo is not resurrected by the fix',
    );
    assert.ok(!fixed.demos.find((d) => d.demo_slug === 'third-agency-rm-0044').resolves);
    assert.ok(fixed.fixed.still_broken >= 1);
    ok('--fix compiles the missing rows, leaves archived links retired, and still reports what it could not fix');

    const fifth = fixed.demos.find((d) => d.probe_id === 'prb_demo_005');
    assert.ok(fifth && fifth.resolves, 'the probe that never had a demo row now has a working link');
    ok('a personalised probe whose demo was never generated is compiled and resolves');
  }

  __setRepoForTests(null);
  console.log(`\n✅ novus-demo-selftest: ${passed} checks passed\n`);
}

run().catch((err) => {
  console.error('\n❌ novus-demo-selftest FAILED\n');
  console.error(err);
  process.exit(1);
});
