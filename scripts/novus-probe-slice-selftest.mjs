// scripts/novus-probe-slice-selftest.mjs — hermetic VERTICAL SLICE test
// (no network, no credentials, no production data touched).
//
// Drives the real code paths, end to end, against the same in-memory fake of
// the Google Sheets values API the other selftests use:
//
//   agency probe URL → agency resolution → automatic Rightmove extraction
//   → forced scraper failure → screenshot fallback (vision extraction, with the
//   Anthropic call stubbed) → confirmation → probe-create (correct agency_id,
//   duplicate guard) → PROBES row written → MARK AS SENT → OBSERVING with the
//   4-day deadline → inbound email communication → deterministic agency + probe
//   match → evidence recompute → intelligence recompute → A-H grade → window
//   close → probe CLOSED.
//
// Run:  npm run novus:probe-slice
//
// NOTE: real Google Sheets, Gmail/Make and Twilio are external configuration;
// this test proves the CODE path. See the milestone report for the exact
// external configuration each channel still needs.

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { resolveAgency } from '../lib/agencies.mjs';
import { parseListingHtml, isSufficient, extractPostcode } from '../lib/rightmove-meta.mjs';
import { extractPropertyFromImage, parseImagePayload, sanitiseVisionFields } from '../lib/vision-extract.mjs';
import { recomputeProbeObservation } from '../lib/observation-recompute.mjs';

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'owner_md','independent_franchise_corporate','sales_led_lettings_only','years_trading',
  'incorporation_date','live_listing_count','crm_name','crm_evidence','qualification_segment',
  'current_pipeline_status','suppression_status','suppression_reason','notes','created_at','updated_at',
];
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
const RAW_EVENTS_HEADER = [
  'raw_event_id','provider','provider_event_id','channel','event_type','received_at','occurred_at',
  'source_identifier','destination_identifier','payload_reference','processing_status',
  'processed_communication_id','error_message','created_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id','agency_id','probe_id','observation_status','observation_deadline',
  'auto_acknowledgement','auto_ack_timestamp','crm_detected','crm_name','crm_evidence',
  'first_human_touch','first_human_touch_at','human_lag_hours','callback_attempts',
  'successful_conversations','voicemail_count','follow_up_count','follow_up_channels',
  'last_touch_at','days_chased','booking_attempt','contact_quality','persistence_profile',
  'channels_used','grade','grade_reason','observation_closed_at','created_at','updated_at',
];

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    RAW_EVENTS: [RAW_EVENTS_HEADER.slice(), ['SCHEMA NOTE', 'Immutable provider event audit trail.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'One row per probe.']],
  };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const tab = tabOf(range);
      const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
  };
  return { store, valuesApi };
}

function seedAgency(store, agency) {
  store.AGENCIES.push(AGENCIES_HEADER.map((k) => agency[k] ?? ''));
}

const BASIC = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
function mockReq({ method = 'POST', body = {}, query = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: {
      authorization: BASIC,
      'content-type': 'application/json',
      'x-novus-ingest-secret': 'test-ingest-secret', // email adapter's own auth
    },
  };
}
function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

// A realistic (trimmed) Rightmove property page: window.PAGE_MODEL, exactly the
// shape the parser targets.
const RIGHTMOVE_HTML = `<!doctype html><html><head>
<meta property="og:title" content="4 bedroom detached house for sale in Wren Close, Bicester, OX26" />
<meta property="og:description" content="A well presented four bedroom home. Guide price £575,000." />
</head><body><script>
window.PAGE_MODEL = {"propertyData":{
  "id":"123456789",
  "bedrooms":4,"bathrooms":2,
  "propertySubType":"Detached",
  "transactionType":"BUY",
  "address":{"displayAddress":"Wren Close, Bicester, OX26 2AB","outcode":"OX26","incode":"2AB"},
  "prices":{"primaryPrice":"£575,000"},
  "status":{"published":true,"archived":false},
  "customer":{"companyName":"Hilltop & Vale Estates","branchDisplayName":"Bicester"},
  "text":{"description":"<p>A well presented four bedroom detached home with garage.</p>"}
}};
</script></body></html>`;

// A blocked/JS-only page: no model, no useful meta — must be judged insufficient.
const BLOCKED_HTML = '<!doctype html><html><head><title>Rightmove</title></head><body><noscript>Please enable JavaScript</noscript></body></html>';

const DAY_MS = 24 * 60 * 60 * 1000;

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  process.env.NOVUS_PROBE_EMAIL = 'novusprobes@gmail.com';
  process.env.NOVUS_PROBE_PHONE = '+447575333064';
  process.env.NOVUS_INGEST_SECRET = 'test-ingest-secret';

  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  __setRepoForTests(repo);

  seedAgency(store, {
    agency_id: 'AG-0007',
    agency_name: 'Hilltop & Vale Estates',
    domain: 'hilltopvale.co.uk',
    location: 'Bicester',
    main_phone: '01869 555200',
    primary_contact_email: 'sales@hilltopvale.co.uk',
  });
  seedAgency(store, { agency_id: 'AG-0008', agency_name: 'Other Agency', domain: 'other.co.uk' });

  const agencyGet = (await import('../api/novus/agency-get.js')).default;
  const probeCreate = (await import('../api/novus/probe-create.js')).default;
  const markSent = (await import('../api/novus/probe-mark-sent.js')).default;
  const emailInbound = (await import('../api/novus/webhooks/email-inbound.js')).default;

  console.log('\n1) AGENCY IDENTITY — the agency-specific probe URL');
  {
    let res = mockRes();
    await agencyGet(mockReq({ method: 'GET', query: { agency_id: 'AG-0007' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.agency.agency_id, 'AG-0007');
    assert.strictEqual(res.body.agency.agency_name, 'Hilltop & Vale Estates');
    ok('/novus/a/AG-0007 resolves to exactly that agency');

    res = mockRes();
    await agencyGet(mockReq({ method: 'GET', query: { agency_id: '  ag-0007 ' } }), res);
    assert.strictEqual(res.body.agency.agency_id, 'AG-0007');
    ok('a sloppily-cased/padded link still resolves to the CANONICAL agency_id');

    res = mockRes();
    await agencyGet(mockReq({ method: 'GET', query: { agency_id: 'AG-9999' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.match(res.body.error, /does not exist/i);
    ok('an unknown agency id fails clearly instead of falling back to a guess');

    const missing = await resolveAgency(repo, '');
    assert.deepStrictEqual(missing, { ok: false, reason: 'missing' });
    ok('a probe link with no agency resolves to "missing", never to a default agency');
  }

  console.log('\n2) RIGHTMOVE EXTRACTION — automatic first attempt');
  {
    const f = parseListingHtml(RIGHTMOVE_HTML);
    assert.strictEqual(f.address, 'Wren Close, Bicester, OX26 2AB');
    assert.strictEqual(f.street, 'Wren Close');
    assert.strictEqual(f.postcode, 'OX26 2AB');
    assert.strictEqual(f.price, '£575,000');
    assert.strictEqual(f.bedrooms, 4);
    assert.strictEqual(f.bathrooms, 2);
    assert.strictEqual(f.property_type, 'Detached');
    assert.strictEqual(f.listing_status, 'live');
    assert.strictEqual(f.agent_branch, 'Hilltop & Vale Estates — Bicester');
    assert.ok(/four bedroom detached home/i.test(f.details));
    assert.strictEqual(isSufficient(f), true);
    ok('price, beds, baths, address, street, postcode, type, status, agent/branch and details all extracted');

    assert.strictEqual(extractPostcode('12 High St, Oxford, OX1 1AA'), 'OX1 1AA');
    ok('postcode extraction is deterministic');
  }

  console.log('\n3) FORCED SCRAPER FAILURE — screenshot fallback activates');
  {
    const blocked = parseListingHtml(BLOCKED_HTML);
    assert.strictEqual(isSufficient(blocked), false);
    ok('a blocked/JS-only listing is judged INSUFFICIENT (→ screenshot fallback), not silently accepted');

    const empty = parseListingHtml('');
    assert.strictEqual(isSufficient(empty), false);
    ok('a total extraction failure does not throw — it degrades to the fallback');
  }

  console.log('\n4) SCREENSHOT FALLBACK — clipboard image → structured data');
  {
    const png = parseImagePayload({ image_base64: 'data:image/png;base64,aGVsbG8=', media_type: '' });
    assert.strictEqual(png.ok, true);
    assert.strictEqual(png.media_type, 'image/png');
    ok('a CTRL+V clipboard data: URL (PNG) is accepted and decoded');

    const jpeg = parseImagePayload({ image_base64: 'aGVsbG8=', media_type: 'image/jpeg' });
    assert.strictEqual(jpeg.ok, true);
    ok('bare base64 + image/jpeg is accepted');

    const bad = parseImagePayload({ image_base64: 'data:application/pdf;base64,aGVsbG8=' });
    assert.strictEqual(bad.ok, false);
    ok('a non-image clipboard payload is rejected with a clear message');

    // Vision call stubbed — proves OUR parsing/sanitising, no API key needed.
    const stub = async () => JSON.stringify({
      address: 'Wren Close, Bicester, OX26 2AB', street: 'Wren Close', postcode: 'ox26 2ab',
      price: '£575,000', bedrooms: 4, bathrooms: 2, property_type: 'Detached',
      listing_status: 'For sale', agent_branch: 'Hilltop & Vale Estates', title: '4 bed detached',
      details: 'Four bedroom detached home with garage.',
    });
    const shot = await extractPropertyFromImage({ image_base64: 'aGVsbG8=', media_type: 'image/png' }, stub);
    assert.strictEqual(shot.ok, true);
    assert.strictEqual(shot.fields.bedrooms, 4);
    assert.strictEqual(shot.fields.postcode, 'OX26 2AB');
    assert.strictEqual(isSufficient(shot.fields), true);
    ok('screenshot extraction produces the SAME structured field bag as the URL path');

    const nulls = sanitiseVisionFields({ address: 'X', bedrooms: null, price: null, bathrooms: 'unknown' });
    assert.strictEqual(nulls.bedrooms, null);
    assert.strictEqual(nulls.price, '');
    assert.strictEqual(nulls.bathrooms, null);
    ok('fields the screenshot does not show stay blank — never invented');

    const junk = await extractPropertyFromImage({ image_base64: 'aGVsbG8=', media_type: 'image/png' }, async () => 'sorry, I cannot help');
    assert.strictEqual(junk.ok, false);
    ok('an unparseable AI reply fails safely rather than producing fabricated fields');
  }

  console.log('\n5) PROBE CREATION — confirmed data, correct agency, no duplicates');
  let probeId;
  {
    const confirmed = {
      address: 'Wren Close, Bicester, OX26 2AB', street: 'Wren Close', postcode: 'OX26 2AB',
      price: '£575,000', bedrooms: '4', bathrooms: '2', property_type: 'Detached',
      listing_status: 'For sale', agent_branch: 'Hilltop & Vale Estates — Bicester',
      title: '4 bed detached', details: 'Four bedroom detached home with garage.',
    };

    let res = mockRes();
    await probeCreate(mockReq({ body: { url: 'https://www.rightmove.co.uk/properties/123456789', property: confirmed, extraction_source: 'screenshot' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /No agency in this probe link/i);
    ok('probe creation REFUSES a request with no agency — no orphan probe is ever written');

    res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: 'AG-9999', url: 'https://www.rightmove.co.uk/properties/1', property: confirmed } }), res);
    assert.strictEqual(res.statusCode, 404);
    ok('probe creation refuses an unresolvable agency id');

    res = mockRes();
    await probeCreate(mockReq({ body: {
      agency_id: 'ag-0007', // as it might appear in a pasted link
      url: 'https://www.rightmove.co.uk/properties/123456789',
      property: confirmed,
      enquiry_text: 'Is this still available? Could I arrange a viewing this week?',
      extraction_source: 'screenshot',
    } }), res);
    assert.strictEqual(res.statusCode, 200);
    const probe = res.body.probe;
    probeId = probe.probe_id;
    assert.strictEqual(probe.agency_id, 'AG-0007');
    assert.strictEqual(probe.probe_status, 'draft');
    assert.strictEqual(probe.property_address, 'Wren Close, Bicester, OX26 2AB');
    assert.strictEqual(probe.property_price, '£575,000');
    assert.strictEqual(probe.property_url, 'https://www.rightmove.co.uk/properties/123456789');
    assert.ok(probe.probe_reference);
    assert.strictEqual(probe.probe_email, 'novusprobes@gmail.com');
    assert.strictEqual(probe.probe_phone, '+447575333064');
    ok('probe created with the CANONICAL agency_id, confirmed property data and probe identity');

    // The written PROBES row (not just the response) carries the agency id.
    const written = await repo.findById('PROBES', 'probe_id', probeId);
    assert.strictEqual(written.obj.agency_id, 'AG-0007');
    assert.ok(written.obj.observation_notes.includes('Beds: 4'));
    assert.ok(written.obj.observation_notes.includes('Postcode: OX26 2AB'));
    assert.ok(written.obj.observation_notes.includes('screenshot'));
    ok('the Google Sheets PROBES row itself stores agency_id + the extra property attributes');

    res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: 'AG-0007', url: 'https://WWW.rightmove.co.uk/properties/123456789?utm=x', property: confirmed } }), res);
    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(res.body.probe.probe_id, probeId);
    ok('re-submitting the same listing for the same agency returns the existing probe, not a second one');

    res = mockRes();
    await probeCreate(mockReq({ body: { agency_id: 'AG-0008', url: 'https://www.rightmove.co.uk/properties/123456789', property: confirmed } }), res);
    assert.strictEqual(res.body.duplicate, false);
    assert.notStrictEqual(res.body.probe.probe_id, probeId);
    ok('the duplicate guard is per AGENCY — a different agency probing the same listing is allowed');
  }

  console.log('\n6) LIFECYCLE — SENT → OBSERVING with the authoritative 4-day window');
  {
    const before = Date.now();
    const res = mockRes();
    await markSent(mockReq({ body: { probe_id: probeId } }), res);
    assert.strictEqual(res.statusCode, 200);
    const p = res.body.probe;
    assert.strictEqual(p.probe_status, 'observing');
    const sentMs = new Date(p.probe_timestamp).getTime();
    assert.ok(sentMs >= before && sentMs <= Date.now(), 'sent timestamp is server-side now');
    const spanDays = (new Date(p.observation_deadline).getTime() - sentMs) / DAY_MS;
    assert.strictEqual(spanDays, 4);
    ok('MARK AS SENT sets probe_status=observing, a server-authoritative timestamp and a 4-day deadline');

    const res2 = mockRes();
    await markSent(mockReq({ body: { probe_id: probeId } }), res2);
    assert.strictEqual(res2.body.already_sent, true);
    assert.strictEqual(res2.body.probe.probe_timestamp, p.probe_timestamp);
    ok('marking sent twice never restarts the observation window');

    const persisted = await repo.findById('PROBES', 'probe_id', probeId);
    assert.strictEqual(persisted.obj.probe_status, 'observing');
    assert.strictEqual(persisted.obj.observation_deadline, p.observation_deadline);
    ok('the observation state persists in the workbook, not just in the response');
  }

  console.log('\n7) COMMUNICATIONS — deterministic matching to agency + active probe');
  {
    // Auto-acknowledgement from the agency's known domain, 12 minutes in.
    let res = mockRes();
    await emailInbound(mockReq({ body: {
      provider: 'gmail', provider_event_id: 'evt-auto-1', channel: 'email',
      from: 'no-reply@hilltopvale.co.uk', to: 'novusprobes@gmail.com',
      subject: 'Thank you for your enquiry',
      body_text: 'This is an automated message. We have received your enquiry.',
      occurred_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    } }), res);
    assert.strictEqual(res.body.match_status, 'matched');
    assert.strictEqual(res.body.agency_id, 'AG-0007');
    assert.strictEqual(res.body.probe_id, probeId);
    assert.strictEqual(res.body.matching_method, 'domain_exact');
    ok('an inbound email matches the right agency (domain_exact) and its ACTIVE probe');

    // Unknown sender — must NOT be attached to anything.
    res = mockRes();
    await emailInbound(mockReq({ body: {
      provider: 'gmail', provider_event_id: 'evt-stranger', channel: 'email',
      from: 'someone@totally-unknown-agency.co.uk', subject: 'Hi', body_text: 'Hello',
    } }), res);
    assert.strictEqual(res.body.match_status, 'unmatched');
    assert.strictEqual(res.body.agency_id, '');
    assert.strictEqual(res.body.probe_id, '');
    ok('an unknown sender stays UNMATCHED and reviewable — never guessed onto this probe');

    // Redelivery of the same provider event must not duplicate evidence.
    res = mockRes();
    await emailInbound(mockReq({ body: {
      provider: 'gmail', provider_event_id: 'evt-auto-1', channel: 'email', from: 'no-reply@hilltopvale.co.uk',
    } }), res);
    assert.strictEqual(res.body.duplicate, true);
    ok('a redelivered provider event is idempotent — one raw event, one communication');

    // A real person replies 40 minutes in, then follows up 3 hours later.
    for (const [id, mins, subject, text] of [
      ['evt-human-1', 40, 'Re: Wren Close', 'Hi, thanks for getting in touch — are you free to view this week?'],
      ['evt-human-2', 180, 'Re: Wren Close', 'Just following up — I can arrange a viewing on Thursday. Would you like to book a viewing?'],
    ]) {
      const r = mockRes();
      await emailInbound(mockReq({ body: {
        provider: 'gmail', provider_event_id: id, channel: 'email',
        from: 'sales@hilltopvale.co.uk', to: 'novusprobes@gmail.com',
        subject, body_text: text,
        occurred_at: new Date(Date.now() - (240 - mins) * 60 * 1000).toISOString(),
      } }), r);
      assert.strictEqual(r.body.probe_id, probeId);
    }
    ok('subsequent human replies match to the same agency and the same active probe');
  }

  console.log('\n8) EVIDENCE → INTELLIGENCE → A-H');
  {
    const result = await recomputeProbeObservation(repo, probeId);
    assert.ok(result, 'recompute ran');
    assert.strictEqual(result.observation.auto_acknowledgement, true);
    assert.strictEqual(result.observation.first_human_touch, 'yes');
    assert.strictEqual(result.observation.follow_up_count, 1);
    assert.strictEqual(result.observation.booking_attempt, true);
    ok('matched communications recompute the evidence (auto-ack, human touch, follow-up, booking attempt)');

    const intel = (await repo.getRecords('INTELLIGENCE', 'intelligence_id')).filter((r) => r.obj.probe_id === probeId);
    assert.strictEqual(intel.length, 1);
    assert.strictEqual(intel[0].obj.agency_id, 'AG-0007');
    assert.strictEqual(intel[0].obj.observation_status, 'observing');
    ok('intelligence recomputes into exactly ONE row per probe, carrying the agency_id through');

    assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(result.grade), `expected a human-contact grade, got ${result.grade}`);
    assert.ok(result.grade_reason.includes('Source Master §10'));
    ok(`A-H grading remains functional (grade ${result.grade} from the deterministic rules engine)`);

    // Idempotency: a second recompute updates the same row, same grade.
    const again = await recomputeProbeObservation(repo, probeId);
    const intel2 = (await repo.getRecords('INTELLIGENCE', 'intelligence_id')).filter((r) => r.obj.probe_id === probeId);
    assert.strictEqual(intel2.length, 1);
    assert.strictEqual(again.grade, result.grade);
    ok('recompute is idempotent — no duplicated intelligence rows, stable grade');
  }

  console.log('\n9) WINDOW CLOSE — the 4-day deadline is authoritative');
  {
    // Age the probe past its deadline (as time would), then recompute.
    const past = new Date(Date.now() - 5 * DAY_MS).toISOString();
    await repo.updateById('PROBES', 'probe_id', probeId, {
      probe_timestamp: past,
      observation_deadline: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    });
    const result = await recomputeProbeObservation(repo, probeId);
    const persisted = await repo.findById('PROBES', 'probe_id', probeId);
    assert.strictEqual(persisted.obj.probe_status, 'closed');
    assert.ok(persisted.obj.observation_closed_at);
    assert.strictEqual(result.probe_closed, true);
    ok('once the 4-day deadline passes the probe CLOSES (draft → observing → closed)');

    const intel = (await repo.getRecords('INTELLIGENCE', 'intelligence_id')).find((r) => r.obj.probe_id === probeId);
    assert.strictEqual(intel.obj.observation_status, 'closed');
    ok('intelligence reflects the closed observation status');

    // A late communication must no longer attach to the closed probe.
    const res = mockRes();
    await emailInbound(mockReq({ body: {
      provider: 'gmail', provider_event_id: 'evt-late', channel: 'email',
      from: 'sales@hilltopvale.co.uk', subject: 'Late', body_text: 'Sorry for the delay',
    } }), res);
    assert.strictEqual(res.body.agency_id, 'AG-0007');
    assert.strictEqual(res.body.probe_id, '');
    ok('a communication arriving after the window matches the agency but attaches to NO probe');

    // Closing twice changes nothing.
    const before = (await repo.findById('PROBES', 'probe_id', probeId)).obj.observation_closed_at;
    const rerun = await recomputeProbeObservation(repo, probeId);
    const after = (await repo.findById('PROBES', 'probe_id', probeId)).obj.observation_closed_at;
    assert.strictEqual(before, after);
    assert.strictEqual(rerun.probe_closed, false);
    ok('closing is idempotent — observation_closed_at is never re-dated by a later recompute');
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ FAILED:', err); process.exit(1); });
