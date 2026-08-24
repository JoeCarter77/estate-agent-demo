// scripts/novus-demo-selftest.mjs — hermetic end-to-end test (no network, no
// creds, no AI) for the personalised demo:
//
//   PROBES + AGENCIES + INTELLIGENCE + DIAGNOSIS_FINDINGS + PERSONALISATION
//     -> DEMOS row  ->  GET /api/demo?slug=...  ->  render-ready payload
//
// It runs the REAL api/demo.js handler over an in-memory workbook seeded with
// live-shaped headers, and proves the things that would otherwise only fail in
// front of a prospect:
//
//   A. property-image extraction is pure, picks the LARGEST listing photo,
//      rejects logos/floorplans/EPCs, and returns '' for a blocked page
//   B. one weak_seller_qualification probe builds a complete DEMOS row
//   C. an unsupported hero_journey is REFUSED, not fudged into another shape
//   D. the three draft journeys build, but warn and stay `draft`
//   E. the slug is deterministic, and a second probe never steals another's
//   F. GET by slug returns render-ready JSON with no pipeline keys in it
//   G. a view increments telemetry; ?preview=1 does not; archived is gone
//   H. the CTA records once — a reload is not a second signal
//   I. a rebuild is idempotent: same slug, same created_at, telemetry intact
//   J. the demo write path is authed; the read path is not
//
// Run: npm run novus:demo-selftest

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import demoHandler from '../api/demo.js';
import {
  DEMOS_HEADER, buildDemoRow, buildDemoSlug, formatResponseTime, formatChannels,
  sentenceCase, toRenderReady,
} from '../lib/demos.mjs';
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
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
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
  return { store, repo: createRepo(valuesApi) };
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
} = {}) {
  store.PROBES.push(row(PROBES_HEADER, {
    probe_id: probeId,
    probe_reference: probeReference,
    agency_id: agencyId,
    portal: 'rightmove',
    property_address: 'Barn Field, Chevington (2 bed semi, £375,000)',
    property_url: 'https://www.rightmove.co.uk/properties/123456789',
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
  console.log('\nPart B — building a weak_seller_qualification DEMOS row');
  let builtRow;
  {
    const { store } = makeWorkbook();
    seedWeakSeller(store);
    const probe = Object.fromEntries(PROBES_HEADER.map((k, i) => [k, store.PROBES[2][i] ?? '']));
    const agency = Object.fromEntries(AGENCIES_HEADER.map((k, i) => [k, store.AGENCIES[1][i] ?? '']));
    const intelligence = Object.fromEntries(INTELLIGENCE_HEADER.map((k, i) => [k, store.INTELLIGENCE[1][i] ?? '']));
    const personalisation = Object.fromEntries(PERSONALISATION_HEADER.map((k, i) => [k, store.PERSONALISATION[1][i] ?? '']));
    const findings = [
      { finding_index: 1, finding_type: 'opportunity', finding: 'The declared property to sell was asked about once and never converted into a valuation.', evidence: 'no valuation offered in any message', significance_note: 'An instruction lead was recognised in words and left on the table.' },
      { finding_index: 2, finding_type: 'positive', finding: 'The team followed up quickly across two channels.', evidence: 'Voicemail and email inside 23 minutes', significance_note: 'Shows genuine persistence.' },
    ];

    const { row: built, warnings } = buildDemoRow({
      probe, agency, intelligence, findings, personalisation,
      propertyImageUrl: 'https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_656x437.jpeg',
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

    assert.ok(built.demo_hook.includes('23 minutes'), 'the hook credits the real response time');
    assert.strictEqual(built.demo_reveal, "The buyer was handled. The potential instruction wasn't.");
    ok('the hook is data-aware and the reveal is the locked journey line');

    // Prospect-facing copy comes from PERSONALISATION, raised to a sentence —
    // never rewritten.
    assert.ok(built.positive_observation.startsWith('You came back inside 23 minutes'));
    assert.ok(built.commercial_consequence.startsWith('A valuation that was already inside'));
    ok('positive observation and consequence are PERSONALISATION copy, sentence-cased only');

    const events = JSON.parse(built.observed_events_json);
    assert.ok(events.length >= 5 && events.length <= 7, `expected a SHORT event list, got ${events.length}`);
    assert.deepStrictEqual(events[0], { label: 'Enquiry submitted', detail: '17 August, 23:34', tone: 'neutral' });
    assert.ok(events.some((e) => e.label === 'Property to sell declared'));
    assert.ok(events.some((e) => e.label === '3 contact attempts' && e.detail === 'Across phone and email'));
    assert.ok(events.some((e) => e.label === 'Viewing slot offered' && e.tone === 'good'));
    const sellerEvent = events.find((e) => e.label.startsWith('Seller position asked about'));
    assert.ok(sellerEvent && sellerEvent.tone === 'gap', 'the unconverted seller position is the gap');
    ok('the observed-event list is short, real, and marks exactly one gap');

    const detected = JSON.parse(built.novus_detected_json);
    const decisions = JSON.parse(built.novus_decisions_json);
    const actions = JSON.parse(built.novus_actions_json);
    assert.ok(detected.length > 0 && detected.length <= 3);
    assert.ok(decisions.length > 0 && decisions.length <= 3);
    assert.ok(actions.length > 0 && actions.length <= 3);
    ok('UNDERSTANDS / DECIDES / ACTS are each capped at three lines');

    assert.ok(decisions[0].detail.includes('market appraisal'),
      'the DECIDES beat leads with this probe\'s own novus_counterfactual');
    ok('DECIDES leads with PERSONALISATION.novus_counterfactual, not a template');

    assert.ok(actions.some((a) => a.owner === 'novus') && actions.some((a) => a.owner === 'team'));
    ok('ACTS names both what NOVUS does and what routes to the team');

    assert.ok(built.cta_headline.includes('Ensum Brown'));
    assert.ok(built.systemic_bridge.includes('not replace them'));
    ok('the CTA names the agency and the bridge line is the locked copy');

    assert.strictEqual(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`);
    ok('a complete probe builds with no warnings');
  }
  {
    // A missing image is a warning, never a failure.
    const { store } = makeWorkbook();
    seedWeakSeller(store);
    const probe = Object.fromEntries(PROBES_HEADER.map((k, i) => [k, store.PROBES[2][i] ?? '']));
    const personalisation = Object.fromEntries(PERSONALISATION_HEADER.map((k, i) => [k, store.PERSONALISATION[1][i] ?? '']));
    const { row: built, warnings } = buildDemoRow({
      probe, agency: { agency_name: 'Ensum Brown' }, intelligence: {}, findings: [], personalisation,
      propertyImageUrl: '',
    });
    assert.strictEqual(built.property_image_url, '');
    assert.ok(warnings.some((w) => w.includes('property_image_url')));
    ok('a blank property image warns and still produces a complete row');
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
    ok('only weak_seller_qualification is authored; the other three warn as draft');
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

  // ══ Part D — slugs ════════════════════════════════════════════════════════
  console.log('\nPart D — demo slugs');
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

  // ══ Part E — render-ready projection ══════════════════════════════════════
  console.log('\nPart E — what the browser receives');
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

  // ══ Part F/G/H/I/J — the route, end to end ════════════════════════════════
  console.log('\nPart F — build, publish and serve one demo through /api/demo');
  {
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    __setRepoForTests(repo);

    // BUILD (authed) — no network: the image is supplied rather than fetched.
    const buildRes = mockRes();
    await demoHandler(mockReq({
      body: {
        action: 'build',
        probe_id: 'prb_demo_001',
        publish: true,
        property_image_url: 'https://media.rightmove.co.uk/dir/123/IMG_01_0000_max_656x437.jpeg',
      },
    }), buildRes);
    assert.strictEqual(buildRes.statusCode, 200, JSON.stringify(buildRes.body));
    assert.strictEqual(buildRes.body.demo_slug, 'ensum-brown-rm-0042');
    assert.strictEqual(buildRes.body.demo_url, '/demo/ensum-brown-rm-0042');
    assert.strictEqual(buildRes.body.demo_status, 'published');
    assert.deepStrictEqual(buildRes.body.warnings, []);
    assert.strictEqual(demoRowsOf(store).length, 1);
    ok('build writes exactly one DEMOS row and returns /demo/{slug}');

    // Nothing upstream may be touched by a demo build.
    assert.strictEqual(store.PROBES.length, 3);
    assert.strictEqual(store.PERSONALISATION.length, 2);
    assert.strictEqual(store.INTELLIGENCE.length, 2);
    assert.strictEqual(store.DIAGNOSIS_FINDINGS.length, 3);
    ok('building a demo writes nothing back into PROBES/INTELLIGENCE/FINDINGS/PERSONALISATION');

    // GET — the prospect's request.
    const getRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042' }, auth: false }), getRes);
    assert.strictEqual(getRes.statusCode, 200);
    assert.strictEqual(getRes.body.draft, false);
    assert.strictEqual(getRes.body.demo.agency_name, 'Ensum Brown');
    assert.ok(!('probe_id' in getRes.body.demo));
    assert.strictEqual(getRes.headers['Cache-Control'], 'no-store');
    ok('GET /api/demo?slug=… serves the published demo WITHOUT auth');

    console.log('\nPart G — view telemetry');
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

    console.log('\nPart H — CTA telemetry');
    await demoHandler(mockReq({ body: { action: 'cta_click', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    const clickedAt = demoRowsOf(store)[0].cta_clicked_at;
    assert.ok(clickedAt, 'the CTA click is recorded');
    await demoHandler(mockReq({ body: { action: 'cta_click', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    assert.strictEqual(demoRowsOf(store)[0].cta_clicked_at, clickedAt);
    ok('the FIRST CTA click wins — a reload is not a second signal');

    await demoHandler(mockReq({ body: { action: 'meeting_booked', slug: 'ensum-brown-rm-0042' }, auth: false }), mockRes());
    assert.ok(demoRowsOf(store)[0].meeting_booked_at);
    ok('a booked meeting is recorded separately from the click that opened the calendar');

    console.log('\nPart I — rebuild is idempotent');
    const before = demoRowsOf(store)[0];
    const rebuildRes = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' } }), rebuildRes);
    assert.strictEqual(rebuildRes.statusCode, 200);
    assert.strictEqual(demoRowsOf(store).length, 1, 'a rebuild must never append a second row');
    const after = demoRowsOf(store)[0];
    assert.strictEqual(after.demo_slug, before.demo_slug);
    assert.strictEqual(after.demo_id, before.demo_id);
    assert.strictEqual(after.created_at, before.created_at);
    assert.strictEqual(after.demo_status, 'published', 'a rebuild must not silently unpublish');
    assert.strictEqual(after.view_count, before.view_count);
    assert.strictEqual(after.first_viewed_at, before.first_viewed_at);
    assert.strictEqual(after.cta_clicked_at, before.cta_clicked_at);
    assert.strictEqual(after.property_image_url, before.property_image_url, 'a rebuild keeps the image it already has');
    ok('rebuild keeps the URL, the id, created_at, the status, the image and all telemetry');

    console.log('\nPart J — the write path is authed, the read path is not');
    const noAuth = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' }, auth: false }), noAuth);
    assert.strictEqual(noAuth.statusCode, 401);
    ok('build without the NOVUS credential is a 401');

    const unpublishRes = mockRes();
    await demoHandler(mockReq({ body: { action: 'unpublish', slug: 'ensum-brown-rm-0042' } }), unpublishRes);
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'draft');
    const draftRes = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042', preview: '1' }, auth: false }), draftRes);
    assert.strictEqual(draftRes.statusCode, 200);
    assert.strictEqual(draftRes.body.draft, true);
    ok('a draft demo still resolves, flagged as draft, so the URL can be checked before sending');
  }
  {
    // An archived demo is deliberately gone.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store);
    __setRepoForTests(repo);
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001', publish: true } }), mockRes());
    const idx = store.DEMOS.findIndex((r) => r[1] === 'ensum-brown-rm-0042');
    store.DEMOS[idx][DEMOS_HEADER.indexOf('demo_status')] = 'archived';
    const res = mockRes();
    await demoHandler(mockReq({ method: 'GET', query: { slug: 'ensum-brown-rm-0042' }, auth: false }), res);
    assert.strictEqual(res.statusCode, 404);
    ok('an archived demo is a 404');
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
  }
  {
    // A draft journey builds, warns, and cannot reach `published` by accident.
    const { store, repo } = makeWorkbook();
    seedWeakSeller(store, { heroJourney: 'slow_response_gap' });
    __setRepoForTests(repo);
    const res = mockRes();
    await demoHandler(mockReq({ body: { action: 'build', probe_id: 'prb_demo_001' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.warnings.some((w) => w.includes('draft copy')));
    assert.strictEqual(demoRowsOf(store)[0].demo_status, 'draft');
    ok('a draft journey builds with a warning and stays draft');
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
  }

  // ══ Part K — display formatting ═══════════════════════════════════════════
  console.log('\nPart K — display formatting');
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

  __setRepoForTests(null);
  console.log(`\n✅ novus-demo-selftest: ${passed} checks passed\n`);
}

run().catch((err) => {
  console.error('\n❌ novus-demo-selftest FAILED\n');
  console.error(err);
  process.exit(1);
});
