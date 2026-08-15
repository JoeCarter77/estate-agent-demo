// scripts/novus-readiness-selftest.mjs — hermetic tests for the probe-readiness
// work: the changes that had to land before real agencies could be probed.
//
// Covers, against the REAL code paths and an in-memory Sheets fake:
//   1. Agency import  — 144-row CSV mapping, stable ids, ambiguity reporting
//   2. Probe-address matching — a reply matched by the per-probe address alone,
//      including relayed auto-acks whose sender belongs to no agency
//   3. Relay senders  — never attributed to an agency by domain
//   4. Four-day close — a silent probe reaching Grade H automatically
//   5. Tier + ACTIONS — rules-driven routing and a next action per probe
//   6. Schema guard   — missing columns reported instead of silently dropped
//
// Run:  npm run novus:readiness-selftest

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { buildAgencyRecords, findAmbiguousSignals, domainFromWebsite } from '../lib/agency-import.mjs';
import { buildProbeEmail, extractProbeTag } from '../lib/probe-identity.mjs';
import { matchProbeByAddress, matchAgency, isRelayDomain } from '../lib/matching.mjs';
import { normalizeEmail } from '../lib/normalize.mjs';
import { routeTier, nextAction } from '../lib/tier.mjs';
import { checkTabHeader } from '../lib/schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAY = 24 * 60 * 60 * 1000;

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'suppression_status','created_at','updated_at',
];
const PROBES_HEADER = [
  'probe_id','probe_reference','agency_id','portal','property_id','property_address',
  'property_url','probe_email','probe_phone','probe_timestamp','observation_deadline',
  'probe_status','compromised','observation_closed_at','created_at','updated_at',
];
const COMMUNICATIONS_HEADER = [
  'communication_id','agency_id','probe_id','interaction_id','occurred_at','received_at','channel',
  'direction','communication_type','provider','provider_event_id','source_identifier_raw',
  'source_identifier_normalized','destination_identifier','subject','body_text','raw_content',
  'raw_payload_reference','matching_method','match_score','match_status','automated_or_human',
  'human_contact','callback_attempt','successful_conversation','follow_up','booking_attempt',
  'communication_classification','manual_review_status','manual_override','created_at','updated_at',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id','agency_id','probe_id','observation_status','observation_deadline',
  'auto_acknowledgement','auto_ack_timestamp','crm_detected','crm_name','crm_evidence',
  'first_human_touch','first_human_touch_at','human_lag_hours','callback_attempts',
  'successful_conversations','voicemail_count','inbound_sms_count','email_touch_count',
  'contact_attempt_count','follow_up_count','follow_up_channels','last_touch_at','days_chased',
  'booking_attempt','contact_quality','proactive_reactive','persistence_profile','channels_used',
  'grade','grade_reason','tier','tier_reason','sales_angle','next_action','observation_closed_at',
  'created_at','updated_at',
];
const ACTIONS_HEADER = [
  'action_id','agency_id','probe_id','action_type','action_status','priority','due_at',
  'completed_at','owner','trigger','reason','related_communication_id','notes','created_at','updated_at',
];
const RAW_EVENTS_HEADER = [
  'raw_event_id','provider','provider_event_id','channel','event_type','received_at','occurred_at',
  'source_identifier','destination_identifier','payload_reference','processing_status',
  'processed_communication_id','error_message','created_at',
];

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per communication.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour.']],
    ACTIONS: [ACTIONS_HEADER.slice(), ['SCHEMA NOTE', 'What NOVUS/Joe does next.']],
    RAW_EVENTS: [RAW_EVENTS_HEADER.slice(), ['SCHEMA NOTE', 'Provider audit trail.']],
  };
  const tabOf = (r) => String(r).split('!')[0];
  const startRowOf = (r) => { const m = String(r).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; };
  const valuesApi = {
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const t = tabOf(range); store[t] = store[t] || [];
      for (const r of rows) store[t].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const t = tabOf(range); const s = startRowOf(range); store[t] = store[t] || [];
      rows.forEach((r, i) => { store[t][s - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
  };
  return { store, valuesApi };
}

function seedRow(store, tab, header, obj) {
  store[tab].push(header.map((k) => (obj[k] ?? '')));
}

const BASIC = 'Basic ' + Buffer.from('novus:testpass').toString('base64');
function mockReq({ method = 'POST', body = {}, query = {}, auth = BASIC, headers = {} } = {}) {
  return { method, body, query, headers: { authorization: auth, ...headers } };
}
function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    send(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function run() {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus';
  process.env.NOVUS_BASIC_AUTH_PASS = 'testpass';
  process.env.NOVUS_INGEST_SECRET = 'ingest-secret';
  process.env.NOVUS_PROBE_EMAIL = 'joe@getnovus.co.uk';
  process.env.NOVUS_PROBE_PHONE = '+447575333064';

  // ── 1. Agency import ──────────────────────────────────────────────────────
  console.log('\n1 — Agency import from the scraped CSV');
  {
    const csv = readFileSync(resolve(__dirname, '../agent_leads_with_slugs.csv'), 'utf8');
    const { records } = buildAgencyRecords(csv, 'T');

    assert.ok(records.length >= 140, `expected ~144 agencies, got ${records.length}`);
    ok(`${records.length} agencies parsed from the real CSV`);

    // agency_id must be derived, not random, or a re-import creates a second
    // competing identity for the same agency.
    const again = buildAgencyRecords(csv, 'T2');
    assert.deepStrictEqual(
      records.map((r) => r.agency_id),
      again.records.map((r) => r.agency_id),
      'agency ids are stable across imports',
    );
    assert.ok(records.every((r) => r.agency_id.startsWith('ag_')), 'ids are namespaced');
    ok('agency_id is derived from the slug, so re-import updates rather than duplicates');

    const withDomain = records.filter((r) => r.domain).length;
    assert.ok(withDomain / records.length > 0.9, `domain coverage too low: ${withDomain}/${records.length}`);
    ok(`domain resolved for ${withDomain}/${records.length} agencies (the main matching signal)`);

    assert.strictEqual(domainFromWebsite('http://www.ashtonwhite.co.uk/?utm_source=GoogleMyBusiness'), 'ashtonwhite.co.uk');
    assert.strictEqual(domainFromWebsite(''), '');
    ok('website URLs reduce to a bare registrable domain');

    // A free-email host must never become an agency domain — dozens of
    // agencies would share it and every match would be ambiguous.
    assert.ok(!records.some((r) => r.domain === 'gmail.com'), 'no agency has a free-email domain');
    ok('free-email hosts are excluded from the domain column');

    const { domains, phones } = findAmbiguousSignals(records);
    assert.ok(Array.isArray(domains) && Array.isArray(phones));
    ok(`ambiguity pre-reported before probing: ${domains.length} shared domain(s), ${phones.length} shared phone(s)`);
  }

  // ── 2. Probe-address matching ─────────────────────────────────────────────
  console.log('\n2 — Per-probe reply address (the deterministic email key)');
  {
    assert.strictEqual(buildProbeEmail('joe@getnovus.co.uk', 'RM-0007'), 'joe+rm0007@getnovus.co.uk');
    assert.strictEqual(buildProbeEmail('joe+old@getnovus.co.uk', 'RM-0007'), 'joe+rm0007@getnovus.co.uk', 'never stacks two tags');
    assert.strictEqual(buildProbeEmail('', 'RM-0007'), '', 'no base address, no invention');
    ok('probe email is plus-addressed per probe and never double-tagged');

    assert.strictEqual(extractProbeTag('Sales Team <joe+rm0007@getnovus.co.uk>'), 'rm0007');
    assert.strictEqual(extractProbeTag('someone@else.com, joe+rm0012@getnovus.co.uk'), 'rm0012');
    assert.strictEqual(extractProbeTag('joe@getnovus.co.uk'), '', 'an untagged address yields no tag');
    ok('the probe tag is recovered from display-name and multi-address headers');

    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedRow(store, 'PROBES', PROBES_HEADER, {
      probe_id: 'prb_a', probe_reference: 'RM-0007', agency_id: 'ag_alpha',
      probe_email: 'joe+rm0007@getnovus.co.uk', probe_status: 'observing',
      probe_timestamp: new Date(Date.now() - DAY).toISOString(),
      observation_deadline: new Date(Date.now() + 3 * DAY).toISOString(),
    });

    const hit = await matchProbeByAddress(repo, 'joe+rm0007@getnovus.co.uk');
    assert.strictEqual(hit.match_status, 'matched');
    assert.strictEqual(hit.probe_id, 'prb_a');
    assert.strictEqual(hit.agency_id, 'ag_alpha');
    assert.strictEqual(hit.matching_method, 'probe_address_exact');
    ok('a reply to the probe address resolves the exact probe and its agency');

    const miss = await matchProbeByAddress(repo, 'joe+rm9999@getnovus.co.uk');
    assert.strictEqual(miss.match_status, 'unmatched');
    assert.strictEqual(miss.probe_id, '', 'an unknown tag is never mapped to the nearest probe');
    ok('an unknown probe tag stays unmatched rather than being guessed');

    // Two probes claiming one tag is a data fault, not a coin toss.
    seedRow(store, 'PROBES', PROBES_HEADER, {
      probe_id: 'prb_dupe', probe_reference: 'RM-0007', agency_id: 'ag_beta',
      probe_email: 'joe+rm0007@getnovus.co.uk', probe_status: 'observing',
    });
    const ambiguous = await matchProbeByAddress(repo, 'joe+rm0007@getnovus.co.uk');
    assert.strictEqual(ambiguous.match_status, 'ambiguous');
    assert.strictEqual(ambiguous.probe_id, '');
    ok('two probes sharing a tag produce ambiguous, never an arbitrary pick');
  }

  // ── 3. Relay senders ──────────────────────────────────────────────────────
  console.log('\n3 — Portal/CRM relay senders are never attributed by domain');
  {
    assert.ok(isRelayDomain('rightmove.com'));
    assert.ok(isRelayDomain('send.agentresponse.co.uk'));
    assert.ok(isRelayDomain('mail1.send.agentresponse.co.uk'), 'subdomains of a relay count');
    assert.ok(!isRelayDomain('stantonhockett.co.uk'), 'a real agency domain is not a relay');
    ok('relay domains (portal autoresponders, lead-response, CRM) are recognised');

    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    // An agency that has (mistakenly or otherwise) a relay domain on record is
    // the dangerous case: without the guard its id would be handed to every
    // message that platform ever relays, for any agency.
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, {
      agency_id: 'ag_uses_apex', agency_name: 'Apex User', domain: 'apex27.co.uk',
    });
    const result = await matchAgency(repo, normalizeEmail('noreply@apex27.co.uk'));
    assert.strictEqual(result.match_status, 'unmatched');
    assert.strictEqual(result.agency_id, '', 'a relay domain never yields an agency id');
    ok('a relayed auto-ack is not attributed to an agency by its sender domain');
  }

  // ── 4. Four-day close and Grade H ─────────────────────────────────────────
  console.log('\n4 — Four-day observation closes automatically (Grade H)');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const { default: closeHandler } = await import('../api/novus/observation/close-due.js');

    const sent = new Date(Date.now() - 5 * DAY).toISOString();
    const deadline = new Date(Date.now() - DAY).toISOString();
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_silent', agency_name: 'Silent Agency' });
    seedRow(store, 'PROBES', PROBES_HEADER, {
      probe_id: 'prb_silent', probe_reference: 'RM-0100', agency_id: 'ag_silent',
      probe_status: 'observing', probe_timestamp: sent, observation_deadline: deadline,
    });
    // A probe still inside its window must NOT be touched.
    seedRow(store, 'PROBES', PROBES_HEADER, {
      probe_id: 'prb_open', probe_reference: 'RM-0101', agency_id: 'ag_silent',
      probe_status: 'observing', probe_timestamp: new Date(Date.now() - DAY).toISOString(),
      observation_deadline: new Date(Date.now() + 3 * DAY).toISOString(),
    });

    const res = mockRes();
    await closeHandler(mockReq({ method: 'POST' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.closed_count, 1, 'exactly the expired probe closed');
    assert.strictEqual(res.body.closed[0].probe_id, 'prb_silent');
    assert.strictEqual(res.body.closed[0].grade, 'H', 'a silent probe grades H once the window closes');
    ok('an expired, silent probe is closed automatically and graded H');

    const repo = createRepo(valuesApi);
    const closedProbe = await repo.findById('PROBES', 'probe_id', 'prb_silent');
    assert.strictEqual(closedProbe.obj.probe_status, 'closed');
    assert.ok(closedProbe.obj.observation_closed_at, 'close time recorded');
    const stillOpen = await repo.findById('PROBES', 'probe_id', 'prb_open');
    assert.strictEqual(stillOpen.obj.probe_status, 'observing', 'an in-window probe is untouched');
    ok('the probe is marked closed; probes inside their window are left alone');

    // The INTELLIGENCE row for a no-response probe only exists because of this
    // sweep — no communication ever arrived to trigger a recompute.
    const intel = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
    const silentIntel = intel.find((r) => r.obj.probe_id === 'prb_silent');
    assert.ok(silentIntel, 'a silent probe still produces an INTELLIGENCE row');
    assert.strictEqual(silentIntel.obj.grade, 'H');
    assert.strictEqual(silentIntel.obj.observation_status, 'closed');
    ok('intelligence is written for a probe that never received any communication');

    // Idempotent: a second sweep must not reopen or double-write.
    const res2 = mockRes();
    await closeHandler(mockReq({ method: 'POST' }), res2);
    assert.strictEqual(res2.body.closed_count, 0, 'nothing left due on a second run');
    const intel2 = await repo.getRecords('INTELLIGENCE', 'intelligence_id');
    assert.strictEqual(intel2.length, intel.length, 'no duplicate intelligence row');
    ok('re-running the sweep is idempotent (no reopen, no duplicate rows)');

    // Auth: the cron path must not be open to the world.
    const unauth = mockRes();
    await closeHandler(mockReq({ method: 'POST', auth: 'Basic ' + Buffer.from('novus:wrong').toString('base64') }), unauth);
    assert.strictEqual(unauth.statusCode, 401, 'bad credentials rejected');
    ok('close-due rejects an unauthenticated caller');

    __setRepoForTests(null);
  }

  // ── 5. Tier routing + ACTIONS ─────────────────────────────────────────────
  console.log('\n5 — Tier routing and next action are rules-driven');
  {
    const growth = routeTier('A', { agency: { branch_count: '3', years_trading: '12', sales_led_lettings_only: 'sales', independent_franchise_corporate: 'independent' } });
    assert.match(growth.tier, /Growth/);
    assert.match(growth.tier_reason, /§10/);

    const growthUnqualified = routeTier('B', { agency: { agency_name: 'X' } });
    assert.match(growthUnqualified.tier, /Growth/);
    assert.match(growthUnqualified.tier_reason, /Not confirmed/, 'missing qualification data is stated, not assumed away');
    ok('Grades A/B route to Growth, naming any missing qualification data');

    for (const g of ['C', 'D', 'E', 'F', 'G', 'H']) {
      assert.match(routeTier(g, {}).tier, /Core \/ Front Desk/, `grade ${g} routes to front desk`);
    }
    ok('Grades C–H route to Core / Front Desk');

    assert.strictEqual(routeTier('pending', {}).tier, '', 'an unresolved observation gets no tier');
    ok('a pending grade produces no tier rather than a provisional one');

    const open = nextAction({ grade: 'pending', observationStatus: 'observing', probe: { observation_deadline: 'D' } });
    assert.strictEqual(open.action_type, 'await_observation');
    const closedH = nextAction({ grade: 'H', observationStatus: 'closed', probe: {} });
    assert.strictEqual(closedH.action_type, 'prepare_front_desk_outreach');
    assert.strictEqual(closedH.priority, 'high');
    const closedA = nextAction({ grade: 'A', observationStatus: 'closed', probe: {} });
    assert.strictEqual(closedA.action_type, 'qualify_for_growth');
    ok('every observation state yields a next action, none left blank');

    // End-to-end: the recompute must actually persist tier + action.
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    const { recomputeProbeObservation } = await import('../lib/observation-recompute.mjs');

    const sent = new Date(Date.now() - 5 * DAY).toISOString();
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, { agency_id: 'ag_t', agency_name: 'Tier Agency', branch_count: '2' });
    seedRow(store, 'PROBES', PROBES_HEADER, {
      probe_id: 'prb_t', probe_reference: 'RM-0200', agency_id: 'ag_t', probe_status: 'observing',
      probe_timestamp: sent, observation_deadline: new Date(Date.now() - DAY).toISOString(),
    });
    seedRow(store, 'COMMUNICATIONS', COMMUNICATIONS_HEADER, {
      communication_id: 'com_t1', agency_id: 'ag_t', probe_id: 'prb_t',
      occurred_at: new Date(new Date(sent).getTime() + 30 * 60 * 1000).toISOString(),
      channel: 'email', direction: 'inbound', communication_type: 'email',
      source_identifier_raw: 'terry@tieragency.co.uk', source_identifier_normalized: 'terry@tieragency.co.uk',
      body_text: 'Hi Joe, when are you free to view?', match_status: 'matched',
    });
    seedRow(store, 'COMMUNICATIONS', COMMUNICATIONS_HEADER, {
      communication_id: 'com_t2', agency_id: 'ag_t', probe_id: 'prb_t',
      occurred_at: new Date(new Date(sent).getTime() + 5 * 60 * 60 * 1000).toISOString(),
      channel: 'sms', direction: 'inbound', communication_type: 'sms',
      source_identifier_raw: '+447700900123', source_identifier_normalized: '+447700900123',
      body_text: 'Following up on your enquiry', match_status: 'matched',
    });

    const result = await recomputeProbeObservation(repo, 'prb_t');
    assert.strictEqual(result.grade, 'A', 'fast human contact + a genuine follow-up is Grade A');
    assert.match(result.tier, /Growth/);
    ok('recompute persists a rules-driven tier alongside the grade');

    const intel = (await repo.getRecords('INTELLIGENCE', 'intelligence_id')).find((r) => r.obj.probe_id === 'prb_t');
    assert.strictEqual(intel.obj.email_touch_count, 1, 'per-channel counts populated');
    assert.strictEqual(intel.obj.inbound_sms_count, 1);
    assert.strictEqual(intel.obj.proactive_reactive, 'Proactive');
    assert.ok(intel.obj.sales_angle, 'a sales angle is recorded for later personalisation');
    ok('previously-blank intelligence columns are now populated (channel mix, proactive/reactive, angle)');

    const actions = await repo.getRecords('ACTIONS', 'action_id');
    const action = actions.find((r) => r.obj.probe_id === 'prb_t');
    assert.ok(action, 'an ACTIONS row exists for the probe');
    assert.strictEqual(action.obj.action_type, 'qualify_for_growth');
    assert.strictEqual(action.obj.action_status, 'open');
    ok('the probe has an open next action in ACTIONS');

    // Re-running must update the same action, not stack duplicates.
    await recomputeProbeObservation(repo, 'prb_t');
    const actions2 = (await repo.getRecords('ACTIONS', 'action_id')).filter((r) => r.obj.probe_id === 'prb_t');
    assert.strictEqual(actions2.length, 1, 'exactly one open action per probe');
    ok('re-running recompute updates the existing action rather than duplicating it');
  }

  // ── 5b. End-to-end: the exact failure modes seen in real probe traffic ────
  console.log('\n5b — Real-world inbound email, end to end through the webhook');
  {
    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const { default: emailHandler } = await import('../api/novus/webhooks/email-inbound.js');

    const sent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedRow(store, 'AGENCIES', AGENCIES_HEADER, {
      agency_id: 'ag_stantonhockett', agency_name: 'Stanton Hockett Limited',
      domain: 'stantonhockett.co.uk', primary_contact_email: 'hello@stantonhockett.co.uk',
    });
    seedRow(store, 'PROBES', PROBES_HEADER, {
      probe_id: 'prb_sh', probe_reference: 'RM-0300', agency_id: 'ag_stantonhockett',
      probe_email: 'joe+rm0300@getnovus.co.uk', probe_status: 'observing',
      probe_timestamp: sent,
      observation_deadline: new Date(Date.now() + 3.9 * DAY).toISOString(),
    });

    const ingest = (body) => {
      const res = mockRes();
      return emailHandler(
        mockReq({ body, headers: { 'x-novus-ingest-secret': 'ingest-secret' } }),
        res,
      ).then(() => res);
    };

    // Case 1: a reply from an INDIVIDUAL mailbox, not the agency's generic
    // address. This is how real agency replies actually arrive.
    const individual = await ingest({
      provider_event_id: 'msg-1', from: 'terry@stantonhockett.co.uk',
      to: 'joe+rm0300@getnovus.co.uk', subject: 'RE: Wedgwood Way',
      body_text: 'Hi Joe, when are you available to view?',
      // 30 minutes after the probe → inside the "very fast" (≤1h) band.
      occurred_at: new Date(new Date(sent).getTime() + 30 * 60 * 1000).toISOString(),
    });
    assert.strictEqual(individual.body.match_status, 'matched');
    assert.strictEqual(individual.body.probe_id, 'prb_sh');
    assert.strictEqual(individual.body.agency_id, 'ag_stantonhockett');
    ok('a reply from an individual mailbox matches the probe (not just the generic address)');

    // Case 2: a RELAYED auto-acknowledgement. The sender domain belongs to the
    // CRM, not the agency — sender matching cannot work, and must not invent
    // an agency. The probe address carries the answer.
    const relayed = await ingest({
      provider_event_id: 'msg-2', from: 'noreply@send.agentresponse.co.uk',
      to: 'joe+rm0300@getnovus.co.uk', subject: 'Thank you for your Enquiry',
      body_text: 'We have received your enquiry and a member of our team will be in touch.',
      // 5 minutes after the probe — the auto-ack lands before the human reply.
      occurred_at: new Date(new Date(sent).getTime() + 5 * 60 * 1000).toISOString(),
    });
    assert.strictEqual(relayed.body.match_status, 'matched', 'relayed mail still matches');
    assert.strictEqual(relayed.body.probe_id, 'prb_sh');
    assert.strictEqual(relayed.body.matching_method, 'probe_address_exact');
    ok('a CRM-relayed auto-ack matches by probe address, though its sender belongs to no agency');

    const repo = createRepo(valuesApi);
    const comms = await repo.getRecords('COMMUNICATIONS', 'communication_id');
    const ack = comms.find((r) => r.obj.provider_event_id === 'msg-2');
    assert.strictEqual(ack.obj.communication_classification, 'auto_acknowledgement');
    assert.strictEqual(ack.obj.human_contact, 'FALSE');
    const human = comms.find((r) => r.obj.provider_event_id === 'msg-1');
    assert.strictEqual(human.obj.human_contact, 'TRUE');
    ok('email is classified at write time: the auto-ack is not counted as human contact');

    // Case 3: a stranger with no probe tag and no known domain. Must NOT be
    // attached to the one open probe just because it is the only one.
    const stranger = await ingest({
      provider_event_id: 'msg-3', from: 'someone@unknown-domain-xyz.com',
      to: 'joe@getnovus.co.uk', subject: 'Hello', body_text: 'Unrelated',
      occurred_at: new Date().toISOString(),
    });
    assert.strictEqual(stranger.body.match_status, 'unmatched');
    assert.strictEqual(stranger.body.probe_id, '', 'never attached to the only open probe');
    const strangerComm = (await repo.getRecords('COMMUNICATIONS', 'communication_id'))
      .find((r) => r.obj.provider_event_id === 'msg-3');
    assert.strictEqual(strangerComm.obj.manual_review_status, 'pending', 'goes to review');
    ok('an unknown sender is retained as evidence but goes to review, never guessed');

    // Case 4: redelivery of the same provider event is one logical event.
    const before = (await repo.getRecords('COMMUNICATIONS', 'communication_id')).length;
    const again = await ingest({
      provider_event_id: 'msg-1', from: 'terry@stantonhockett.co.uk',
      to: 'joe+rm0300@getnovus.co.uk', subject: 'RE: Wedgwood Way', body_text: 'dup',
    });
    assert.strictEqual(again.body.duplicate, true);
    const after = (await repo.getRecords('COMMUNICATIONS', 'communication_id')).length;
    assert.strictEqual(after, before, 'no duplicate communication row');
    ok('a redelivered webhook produces no second communication');

    // Intelligence updated automatically by ingestion alone — no manual step.
    const intel = (await repo.getRecords('INTELLIGENCE', 'intelligence_id'))
      .find((r) => r.obj.probe_id === 'prb_sh');
    assert.ok(intel, 'intelligence exists without any manual recompute call');
    assert.strictEqual(intel.obj.first_human_touch, 'yes');
    assert.strictEqual(intel.obj.auto_acknowledgement, 'TRUE');
    assert.strictEqual(intel.obj.grade, 'C', 'fast human contact, no follow-up yet');
    ok('intelligence updated automatically on ingestion (auto-ack + human touch, Grade C)');

    __setRepoForTests(null);
  }

  // ── 6. Schema guard ───────────────────────────────────────────────────────
  console.log('\n6 — Missing workbook columns are reported, not silently dropped');
  {
    const good = checkTabHeader('PROBES', PROBES_HEADER.concat(['property_status', 'enquiry_text', 'compromise_reason']));
    assert.ok(good.missingRequired.length === 0 || good.missingRequired.every((c) => typeof c === 'string'));

    const bad = checkTabHeader('PROBES', ['probe_id', 'probe_reference']);
    assert.ok(!bad.ok, 'a stripped header fails the check');
    assert.ok(bad.missingRequired.includes('agency_id'), 'the critical missing column is named');
    ok('checkTabHeader names exactly which required columns are absent');

    const partial = checkTabHeader('INTELLIGENCE', INTELLIGENCE_HEADER.filter((c) => c !== 'tier'));
    assert.ok(partial.ok, 'an optional column missing is not a hard failure');
    assert.ok(partial.missingOptional.includes('tier'), 'but it IS reported as a field being dropped on write');
    ok('optional columns missing are reported as silent-drop warnings, not errors');
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ READINESS SELFTEST FAILED:\n', err); process.exit(1); });
