// scripts/novus-proactive-booking-push-selftest.mjs — hermetic test for
// COMMUNICATIONS.contact_quality = 'proactive_booking_push', covering:
//   1. lib/classification.mjs's detectProactiveBookingPush() against all 14
//      real historical viewing/booking-related human messages (verbatim
//      text from NOVUS_Data_V1_Master_v2).
//   2. The live wiring (lib/intelligence-rebuild.mjs /
//      lib/observation-recompute.mjs) setting contact_quality on NEW rows,
//      alongside proof that booking_attempt, communication_classification,
//      vendor intent and the A-H grade are all unaffected.
//   3. lib/communications-backfill.mjs run against ALL 52 real historical
//      COMMUNICATIONS rows (verbatim, seeded exactly as they exist in the
//      live sheet today — already classified, contact_quality blank) —
//      proving the backfill reaches the same result as the live path would,
//      touches nothing else, and is idempotent.
//
// No network, no creds. Run: node scripts/novus-proactive-booking-push-selftest.mjs

import assert from 'node:assert';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { classifyCommunication, detectProactiveBookingPush } from '../lib/classification.mjs';
import { backfillContactQuality } from '../lib/communications-backfill.mjs';

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

function makeFakeSheet() {
  const store = {
    PROBES: [PROBES_HEADER.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), ['SCHEMA NOTE', 'Derived behaviour and official decisions.']],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const valuesApi = {
    async get(range) {
      const tab = tabOf(range);
      return (store[tab] || []).map((r) => r.slice());
    },
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
    async batchUpdate(data) {
      for (const { range, values } of data) {
        const tab = tabOf(range);
        const start = startRowOf(range);
        store[tab] = store[tab] || [];
        values.forEach((row, i) => { store[tab][start - 1 + i] = row.slice(); });
      }
      return { totalUpdatedCells: data.reduce((n, d) => n + d.values[0].length, 0) };
    },
  };
  return { store, valuesApi };
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

// ── VERBATIM real historical text — all 14 viewing/booking-related human
// communications from NOVUS_Data_V1_Master_v2, split by the proposal's
// determination of which show a proactive push. ──
const PROACTIVE_CASES = [
  ['com_hist_e0020', { subject: 'Requested information for Bellhouse Avenue, South Ockendon, RM15', body_text: 'Hi. Please let me know if you would be able to attend a viewing of this property on Saturday 15th August at 3pm. Thank you. Ellie Heiden Grant, Cornwallis Business Centre, Howard Chase, Basildon, Essex.' }],
  ['com_hist_e0022', { subject: '5 Milton Road, Warley', body_text: 'Hi Joe. Many thanks for your enquiry, if you could please let us know your availability for a viewing next week - days and times - we will endeavour to get you booked in. Please could you also confirm your position - sold/selling/nothing to sell?' }],
  ['com_hist_e0023', { subject: 'RE: Potential valuation: Ingrave Road - Buyer from CM12', body_text: 'Hi Joe, Good morning. Thank you for your email in relation to 6, Ingrave House, Ingrave Road, if you would like to view the property, please let me know some suitable dates/times and we can get you booked in.' }],
  ['com_hist_e0026', { subject: '32 Palliser Drive', body_text: "Hi Joe. Thank you for getting in touch, I have phoned you and left a message with my contact number. I'm available to view the flat and would be happy to book a viewing. Please let me know what days and times you have available." }],
  ['com_hist_e0027', { subject: 'RE: Potential valuation: Rayleigh Road - Buyer from CM12', body_text: 'Hi Joe. Thank you for your enquiry, are you available to view at 10am Friday morning. Thanks. Jack Jaques, Associate Director.' }],
  ['com_hist_e0029', { subject: 'Flat 3, Clive House, 61 Shenfield Road', body_text: 'Good morning Joe. Thank you for your Rightmove enquiry to view Flat 3, Clive House. I would be delighted to arrange a viewing for you, when would be a suitable date and time?' }],
  ['com_hist_e0035', { subject: 'Apartment on Lambourne Chase, Chelmsford', body_text: 'Hi Joe. Hope this email finds you well. I have tried to call regarding your enquiry on the property on Lambourne Chase. Are you available to view Saturday?' }],
  ['com_hist_e0038', { subject: 'RE: Potential valuation: Powell Road - Buyer from CM12', body_text: 'Good morning Joe. Thank you for your Rightmove enquiry for Hamilton Court. What days/times work best for you to view? Kind regards, Emily.' }],
  ['com_hist_e0015', { subject: 'Your viewing request', body_text: "Hello Joe. We received an email from you regarding arranging a viewing for a property, however, we haven't been able to connect with you over the phone and had to leave a message. Please let us know a suitable date and time for the viewing." }],
  ['com_hist_e0013', { subject: 'Walman House, Billericay', body_text: 'Hi Joe, thanks for your enquiry regarding the property we have for sale in Walman House, St Ediths Court, Billericay. I understand you would like to arrange a viewing - if so, just let me know when suits.' }],
  ['com_hist_e0037', { subject: 'Re: Potential valuation: Powell Road - Buyer from CM12', body_text: 'Hi Joe. Thanks for the enquiry. When are you free for a viewing? Kind regards.' }],
];
const GENERIC_CASES = [
  ['com_hist_e0021', { subject: 'Requested information for Bellhouse Avenue, South Ockendon, RM15', body_text: 'Thank you for your recent enquiry requesting more information, which I am pleased to provide. Would you like to arrange a viewing? If you have any questions or would like to know more, please do call us.' }],
  ['com_hist_e0016', { subject: 'Kathy Crown Estate Agents re inquiry', body_text: 'Hi Joe. Thank you for your inquiry. We have tried to call you regarding Fox Cottage. If you would care to call back or email, we can make you an appointment to view.' }],
  ['com_hist_c0018', { channel: 'voice', transcript: "Hi, this is Debs from Farsons Property Group. You put in a request to view Clive House flat in Shenfield Road. If you'd like to call me back, then I can arrange a viewing for you. 01277288850." }],
];

async function run() {
  // ── 1. detectProactiveBookingPush against all 14 real cases ──
  console.log('\n1. detectProactiveBookingPush() against the 14 real historical viewing/booking messages');
  for (const [id, comm] of PROACTIVE_CASES) {
    assert.strictEqual(detectProactiveBookingPush(comm), true, `${id} should detect a proactive push`);
  }
  for (const [id, comm] of GENERIC_CASES) {
    assert.strictEqual(detectProactiveBookingPush(comm), false, `${id} should NOT detect a proactive push (generic/passive)`);
  }
  ok(`all 11 real proactive examples detected true, all 3 real generic/passive examples detected false (11:3 split, matching the proposal)`);

  console.log('\n  Representative PROACTIVE_BOOKING_PUSH examples:');
  for (const [id, comm] of PROACTIVE_CASES.slice(0, 4)) {
    console.log(`    [${id}] "${(comm.body_text || comm.transcript).slice(0, 110)}…"`);
  }
  console.log('\n  Representative blank (generic/passive) examples:');
  for (const [id, comm] of GENERIC_CASES) {
    console.log(`    [${id}] "${(comm.body_text || comm.transcript).slice(0, 110)}…"`);
  }

  // ── 2. classifyCommunication: independence from booking_attempt / communication_classification ──
  console.log('\n2. contact_quality is independent of booking_attempt and communication_classification');
  {
    // com_hist_e0020: the strongest real example, and the one that PROVES
    // independence — it does NOT trip booking_attempt (no literal
    // BOOKING_PHRASES match: "attend a viewing... at 3pm" matches neither
    // 'book a viewing' nor 'arrange a viewing' nor 'available to view').
    const e0020 = classifyCommunication({ subject: 'Requested information for Bellhouse Avenue, South Ockendon, RM15', body_text: 'Hi. Please let me know if you would be able to attend a viewing of this property on Saturday 15th August at 3pm. Thank you.', source_identifier_raw: 'elliegrant@carter-remy.co.uk', channel: 'email' });
    assert.strictEqual(e0020.contact_quality, 'proactive_booking_push', 'e0020 detected as a proactive push');
    assert.strictEqual(e0020.booking_attempt, false, 'e0020 does NOT trip booking_attempt — proves the new signal is independent, not gated on it');
    ok("com_hist_e0020 ('attend a viewing... at 3pm') tags contact_quality=proactive_booking_push even though booking_attempt=false — exactly the blind spot that motivated an independent detector");

    // com_hist_e0026 is both 'reactive' (references the enquiry, mentions a
    // prior call) AND a proactive push (asks for days/times) — two different
    // columns, both populated, no collision.
    const e0026 = classifyCommunication({ subject: '32 Palliser Drive', body_text: "Hi Joe. Thank you for getting in touch, I have phoned you and left a message with my contact number. I'm available to view the flat and would be happy to book a viewing. Please let me know what days and times you have available.", source_identifier_raw: 'lisa@smoothmoveestates.co.uk', channel: 'email' });
    assert.strictEqual(e0026.communication_classification, 'reactive');
    assert.strictEqual(e0026.contact_quality, 'proactive_booking_push');
    assert.strictEqual(e0026.booking_attempt, true);
    ok('com_hist_e0026 carries all three signals at once (reactive + proactive_booking_push + booking_attempt=true) — independent columns, no overwriting');

    // Generic bulk brochure sends must never be mistaken for a proactive push.
    const e0008 = classifyCommunication({ subject: 'Property Details', body_text: 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings.', source_identifier_raw: 'kaly-khan@parabar.co.uk', channel: 'email' });
    assert.strictEqual(e0008.communication_classification, 'generic');
    assert.strictEqual(e0008.contact_quality, '', 'a generic bulk send is never a proactive booking push');
    ok('a generic bulk brochure send correctly gets contact_quality="" alongside communication_classification="generic"');
  }

  // ── 3. Live wiring: new communications get contact_quality automatically ──
  console.log('\n3. Live wiring — lib/intelligence-rebuild.mjs and lib/observation-recompute.mjs set contact_quality on NEW rows');
  {
    const { rebuildAllIntelligence } = await import('../lib/intelligence-rebuild.mjs');
    const { recomputeProbeObservation } = await import('../lib/observation-recompute.mjs');

    const PROBE_SENT = '2026-08-01T21:00:00.000Z';
    const HOUR = 60 * 60 * 1000;
    function iso(offsetMs) { return new Date(new Date(PROBE_SENT).getTime() + offsetMs).toISOString(); }

    // 3a. rebuildAllIntelligence
    {
      const { store, valuesApi } = makeFakeSheet();
      __setRepoForTests(createRepo(valuesApi));
      const repo = createRepo(valuesApi);

      store.PROBES.push(PROBES_HEADER.map((k) => (k === 'probe_id' ? 'prb_push' : k === 'probe_timestamp' ? PROBE_SENT : k === 'observation_deadline' ? iso(4 * 24 * HOUR) : '')));
      store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((k) => {
        if (k === 'communication_id') return 'com_push_1';
        if (k === 'probe_id') return 'prb_push';
        if (k === 'occurred_at') return iso(HOUR);
        if (k === 'channel') return 'email';
        if (k === 'source_identifier_raw') return 'agent@agency.co.uk';
        if (k === 'body_text') return 'Are you available to view at 10am Friday morning?';
        if (k === 'match_status') return 'matched';
        if (k === 'matching_method') return 'email_exact';
        return '';
      }));

      const summary = await rebuildAllIntelligence(repo);
      assert.deepStrictEqual(summary.problems, []);
      const comms = await repo.getRecords('COMMUNICATIONS', 'communication_id');
      assert.strictEqual(comms[0].obj.contact_quality, 'proactive_booking_push', 'rebuild-all sets contact_quality on a brand-new matching communication');

      const intel = (await repo.getRecords('INTELLIGENCE', 'intelligence_id'))[0].obj;
      assert.ok(['A', 'B', 'C', 'D', 'E', 'F'].includes(intel.grade), `A-H grade computed normally (got ${intel.grade}) — contact_quality never touches grading`);
      __setRepoForTests(null);
      ok('rebuildAllIntelligence() sets COMMUNICATIONS.contact_quality on a new proactive-push message; A-H grade unaffected');
    }

    // 3b. recomputeProbeObservation (the webhook path)
    {
      const { store, valuesApi } = makeFakeSheet();
      __setRepoForTests(createRepo(valuesApi));
      const repo = createRepo(valuesApi);

      store.PROBES.push(PROBES_HEADER.map((k) => (k === 'probe_id' ? 'prb_push2' : k === 'probe_timestamp' ? PROBE_SENT : k === 'observation_deadline' ? iso(4 * 24 * HOUR) : '')));
      store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((k) => {
        if (k === 'communication_id') return 'com_push_2';
        if (k === 'probe_id') return 'prb_push2';
        if (k === 'occurred_at') return iso(HOUR);
        if (k === 'channel') return 'voice';
        if (k === 'transcript') return "It's Terry, trying to catch up regarding your inquiry — let me know your availability for a viewing.";
        if (k === 'match_status') return 'matched';
        if (k === 'matching_method') return 'phone_exact';
        return '';
      }));

      await recomputeProbeObservation(repo, 'prb_push2');
      const comm = (await repo.getRecords('COMMUNICATIONS', 'communication_id'))[0].obj;
      assert.strictEqual(comm.contact_quality, 'proactive_booking_push', 'webhook-driven recompute also sets contact_quality');
      assert.strictEqual(comm.communication_classification, 'reactive', 'reactive still set independently on the same row');
      __setRepoForTests(null);
      ok('recomputeProbeObservation() (the live webhook path) sets contact_quality identically — one shared detector, no drift between paths');
    }
  }

  // ── 4. Historical backfill against ALL 52 real historical rows ──
  console.log('\n4. lib/communications-backfill.mjs against all 52 real historical COMMUNICATIONS rows');
  {
    const HIST = [
      ['com_hist_e0008', 'email', 'Property Details', 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings. You have been [registered].', '', 'kaly-khan@parabar.co.uk', 'human'],
      ['com_hist_e0009', 'email', 'Property Details - Outwood Common Road, Billericay', 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings.', '', 'ialderton@parabar.co.uk', 'human'],
      ['com_hist_e0010', 'email', 'Property Details - Kilbarry Walk, Billericay', 'Dear Joe Carter. Please find attached the brochure(s) for properties we think will interest you. Please contact me on 01277 65 65 63 if you are interested in arranging any viewings.', '', 'ialderton@parabar.co.uk', 'human'],
      ['com_hist_e0011', 'email', 'Your Rightmove enquiry', 'Hello Joe. Thank you for your Rightmove enquiry regarding Apt 16, Southwood Court Southend Road, Billericay. To find out how to arrange a viewing, click below to register with us and start on your path [to finding a home].', '', 'info@tylerestates.co.uk', 'automated'],
      ['com_hist_e0012', 'email', 'Welcome to Tyler Estates!', 'Dear Joe. Thank you for contacting Tyler Estates! We are delighted to have the opportunity to assist you with your property needs.', '', 'jeremy@tylerestates.co.uk', 'automated'],
      ['com_hist_e0013', 'email', 'Walman House, Billericay', 'Hi Joe, thanks for your enquiry regarding the property we have for sale in Walman House, St Ediths Court, Billericay. I understand you would like to arrange a viewing - if so, just let me know when suits.', '', 'jay@thepropertyspecialists.co.uk', 'human'],
      ['com_hist_e0014', 'email', 'Thank you for your enquiry..', 'Thank you for your enquiry. Thanks for your enquiry about 2 bedroom terraced house for sale in Whitmore Way, Basildon, SS14. Before we move this forward we just need you to complete our online [registration].', '', 'noreply@gibsonandbrennan.co.uk', 'automated'],
      ['com_hist_e0015', 'email', 'Your viewing request', "Hello Joe. We received an email from you regarding arranging a viewing for a property, however, we haven't been able to connect with you over the phone and had to leave a message. Please let us know a suitable date and time for the viewing.", '', 'daniel@gibsonandbrennan.co.uk', 'human'],
      ['com_hist_e0016', 'email', 'Kathy Crown Estate Agents re inquiry', 'Hi Joe. Thank you for your inquiry. We have tried to call you regarding Fox Cottage. If you would care to call back or email, we can make you an appointment to view.', '', 'enquiries@crownestatesagents.co.uk', 'human'],
      ['com_hist_e0017', 'email', 'Your Rightmove enquiry', 'Hi Joe. Thank you for your Rightmove enquiry regarding Flat 7, 151A High Street, Brentwood. A member of our team will be in touch soon.', '', 'mandy@chalmers-agency.co.uk', 'automated'],
      ['com_hist_e0018', 'email', "We've found some properties for sale you may like", 'Hi Joe. As part of our ongoing efforts to find you a new home, I thought you might be interested in the following properties.', '', 'mandy@chalmers-agency.co.uk', 'automated'],
      ['com_hist_e0019', 'email', 'Thank you for your enquiry', "Your Enquiry has been received. Dear Joe Carter, Thank you for your enquiry on 142 Belhouse Avenue South Ockendon RM15 4BF.", '', 'info@carter-remy.co.uk', 'automated'],
      ['com_hist_e0020', 'email', 'Requested information for Bellhouse Avenue, South Ockendon, RM15', 'Hi. Please let me know if you would be able to attend a viewing of this property on Saturday 15th August at 3pm. Thank you. Ellie Heiden Grant.', '', 'elliegrant@carter-remy.co.uk', 'human'],
      ['com_hist_e0021', 'email', 'Requested information for Bellhouse Avenue, South Ockendon, RM15', 'Thank you for your recent enquiry requesting more information, which I am pleased to provide. Would you like to arrange a viewing?', '', 'elliegrant@carter-remy.co.uk', 'human'],
      ['com_hist_e0022', 'email', '5 Milton Road, Warley', 'Hi Joe. Many thanks for your enquiry, if you could please let us know your availability for a viewing next week - days and times - we will endeavour to get you booked in.', '', 'claire@walkersestates.co.uk', 'human'],
      ['com_hist_e0023', 'email', 'RE: Potential valuation: Ingrave Road - Buyer from CM12', 'Hi Joe, Good morning. Thank you for your email in relation to 6, Ingrave House, Ingrave Road, if you would like to view the property, please let me know some suitable dates/times.', '', 'simone@hs-estateagents.co.uk', 'human'],
      ['com_hist_e0024', 'email', 'Property Details From HS Estate Agents', 'HS Estate Agents. Dear Sir/Madam, Please see below details for a property matching your search criteria.', '', 'sales@hs-estateagents.co.uk', 'automated'],
      ['com_hist_e0025', 'email', 'Sales enquiry: Brentwood - Sales - Buyer from CM12', 'Rightmove Lead: Joe Carter. Opportunities: Wants more details on this property.', '', 'autoresponder@rightmove.com', 'automated'],
      ['com_hist_e0026', 'email', '32 Palliser Drive', "Hi Joe. Thank you for getting in touch, I have phoned you and left a message with my contact number. I'm available to view the flat and would be happy to book a viewing. Please let me know what days and times you have available.", '', 'lisa@smoothmoveestates.co.uk', 'human'],
      ['com_hist_e0027', 'email', 'RE: Potential valuation: Rayleigh Road - Buyer from CM12', 'Hi Joe. Thank you for your enquiry, are you available to view at 10am Friday morning. Thanks. Jack Jaques, Associate Director.', '', 'jack@blueprintproperties.co.uk', 'human'],
      ['com_hist_e0028', 'email', 'Your Rightmove enquiry', 'Hi Joe. Thank you for your Rightmove enquiry regarding Flat 3, Clive House, 61 Shenfield Road. To find out how to arrange a viewing, click below.', '', 'sales@farsonspropertygroup.com', 'automated'],
      ['com_hist_e0029', 'email', 'Flat 3, Clive House, 61 Shenfield Road', 'Good morning Joe. Thank you for your Rightmove enquiry to view Flat 3, Clive House. I would be delighted to arrange a viewing for you, when would be a suitable date and time?', '', 'jo@farsonspropertygroup.com', 'human'],
      ['com_hist_e0030', 'email', 'Thank you for getting in touch!', 'Dear Joe, Thank you for your email enquiring on one of our properties, a member of the team will be in touch very soon.', '', 'noreply@apex27.co.uk', 'automated'],
      ['com_hist_e0031', 'email', 'Property Update', "Dear Joe. I've put together a list of properties that I think may interest you.", '', 'noreply@apex27.co.uk', 'automated'],
      ['com_hist_e0032', 'email', 'Property Update', 'Dear Joe, Please see below a property that I think may be of interest you.', '', 'michael@thehomepartnership.co.uk', 'automated'],
      ['com_hist_e0033', 'email', 'Thank you for your Enquiry', 'Hello Joe Carter. Thank you for your enquiry about 19, Lambourne Chase, Chelmsford, CM2 9FF.', '', 'noreply@send.agentresponse.co.uk', 'automated'],
      ['com_hist_e0034', 'email', 'Getting In The Best Position To Have Your Offer Accepted', 'Thank you for registering your details with us, we will do all we can to find you your perfect property.', '', 'federica@charlesdavidcasson.co.uk', 'automated'],
      ['com_hist_e0035', 'email', 'Apartment on Lambourne Chase, Chelmsford', 'Hi Joe. Hope this email finds you well. I have tried to call regarding your enquiry on the property on Lambourne Chase. Are you available to view Saturday?', '', 'federica@charlesdavidcasson.co.uk', 'human'],
      ['com_hist_e0036', 'email', 'Potential valuation: Powell Road - Buyer from CM12', 'Rightmove Lead: Joe Carter. Opportunities: Has a property to sell: yes, it is not yet on the market.', '', 'autoresponder@rightmove.com', 'automated'],
      ['com_hist_e0037', 'email', 'Re: Potential valuation: Powell Road - Buyer from CM12', 'Hi Joe. Thanks for the enquiry. When are you free for a viewing? Kind regards.', '', 'sales@kilnandlodgeestates.co.uk', 'human'],
      ['com_hist_e0038', 'email', 'RE: Potential valuation: Powell Road - Buyer from CM12', 'Good morning Joe. Thank you for your Rightmove enquiry for Hamilton Court. What days/times work best for you to view? Kind regards, Emily.', '', 'sales@kilnandlodgeestates.co.uk', 'human'],
      ['com_hist_c0001', 'voice', '', '', "Hi, Jerry, it's Terry from Stanton Hockett estate agents. Trying to catch up with you regarding your inquiry on our lovely Wedgewood Way property in Ashingdon area of Rochford. Give me a call back when you're free.", '01277 714777', 'human'],
      ['com_hist_c0002', 'voice', '', '', '', '01277 714777', 'human'],
      ['com_hist_c0003', 'voice', '', '', '', '01277 500800', 'human'],
      ['com_hist_c0004', 'voice', '', '', "Hi, this message for Joe. It's Freddy calling from Tyro Estates. Just calling regarding your request on Southwood. Kind of give me a call back number 012776261811.", '01277 626181', 'human'],
      ['com_hist_c0005', 'voice', '', '', "Oh, good morning, Joe. It's Martin here from Tyler Estates. I'm just coming back to you regarding an inquiry you've made on one of our retirement properties at Southwood Court.", '01277 626181', 'human'],
      ['com_hist_c0006', 'voice', '', '', 'Hello Joe, this is Dan from Gibson and Brennan. Give me a call back when you get this. 01268 219992.', '01268 219992', 'human'],
      ['com_hist_c0007', 'voice', '', '', "Hi, my name's Kathy from a company called Crown State Agents. Fox Cottage in Ramsden Heath. I wonder if you could give us a call back on 012687 11133.", '01268 711133', 'human'],
      ['com_hist_c0008', 'voice', '', '', '', '01268 711133', 'human'],
      ['com_hist_c0009', 'voice', '', '', '', '01277 840917', 'human'],
      ['com_hist_c0010', 'voice', '', '', '[Unable to transcribe from recording.', '01277 288008', 'human'],
      ['com_hist_c0011', 'voice', '', '', 'Hello Joe, this is Jackie calling from WN Properties and Northwood Group. You sent us an inquiry for a possible viewing on a...', '01245 505288', 'human'],
      ['com_hist_c0012', 'voice', '', '', 'Hello.', '01277 260858', 'human'],
      ['com_hist_c0013', 'voice', '', '', "So, good morning. It's been sent from Keith Ashton Estate Agents. You were interested in viewing a property we have in number 11 Hammonds Lane. I'd love to arrange the...", '01277 260858', 'human'],
      ['com_hist_c0014', 'voice', '', '', "Hi Joe, it's Olivia from H Estate Agents. I was just giving you a quick call regarding your enquiry to view one of our properties in Ingrave House. You can give me a call back, the number is 01277220819.", '01277 220819', 'human'],
      ['com_hist_c0015', 'voice', '', '', '', '07984 146509', 'human'],
      ['com_hist_c0016', 'voice', '', '', "Hello, Joe, this is Lisa from Smooth Move Estates. Just received your inquiry regarding the flat in Raynham, Palliser Drive. If you'd like to give me a call back on 07984146509. We can arrange to get round and have a look at it with you.", '07984 146509', 'human'],
      ['com_hist_c0017', 'voice', '', '', "Hello, Joe, it's Lisa from Smooth Move Estates. Just a quick call, really. I'm assuming you haven't replied, so you're not really particularly interested in looking at 32 Palliser Drive.", '07984 146509', 'human'],
      ['com_hist_c0018', 'voice', '', '', "Hi, this is Debs from Farsons Property Group. You put in a request to view Clive House flat in Shenfield Road. If you'd like to call me back, then I can arrange a viewing for you. 01277288850.", '01277 288850', 'human'],
      ['com_hist_c0019', 'voice', '', '', "Hi there, it's Bethany calling from Home Estate Agents. Just giving you a quick call in regards to an inquiry you sent in to us for the property we've got put out on Centenary Way in Bewley. If you can, please return the call.", '01245 250222', 'human'],
      ['com_hist_c0020', 'voice', '', '', "Hi, it's a message for Joe. It's Michael calling from Home Partnership Estate Agents in Chelmsford. Received your inquiry about the property we have for sale on the Centenary Way in Beaulieu Park. Can you give me a call back please on 01245 250222?", '01245 250222', 'human'],
      ['com_hist_c0021', 'voice', '', '', "Hi there, it's Bethany calling from Home Estate Agents. Giving you a quick call. You inquired on a property that we've got for sale...", '01245 250222', 'human'],
    ];
    assert.strictEqual(HIST.length, 52, 'seeding all 52 real historical COMMUNICATIONS rows');

    const { store, valuesApi } = makeFakeSheet();
    __setRepoForTests(createRepo(valuesApi));
    const repo = createRepo(valuesApi);

    for (const [id, channel, subject, body_text, transcript, source_identifier_raw, automated_or_human] of HIST) {
      store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((k) => {
        if (k === 'communication_id') return id;
        if (k === 'channel') return channel;
        if (k === 'subject') return subject;
        if (k === 'body_text') return body_text;
        if (k === 'transcript') return transcript;
        if (k === 'source_identifier_raw') return source_identifier_raw;
        if (k === 'automated_or_human') return automated_or_human; // already classified, as in the live sheet today
        if (k === 'human_contact') return automated_or_human === 'human' ? 'TRUE' : 'FALSE';
        if (k === 'match_status') return 'matched';
        if (k === 'matching_method') return 'historical_import';
        return ''; // contact_quality starts blank, exactly as in the live sheet
      }));
    }

    const summary1 = await backfillContactQuality(repo);
    console.log('\n  Backfill summary (first run):', JSON.stringify(summary1));

    assert.strictEqual(summary1.rows_scanned, 52, 'all 52 historical rows scanned');
    assert.strictEqual(summary1.human_rows_scanned, 37, 'all 37 human rows evaluated (15 automated correctly skipped)');
    assert.strictEqual(summary1.proactive_detected, 11, 'exactly 11 real proactive_booking_push examples detected — matches the proposal exactly');
    assert.strictEqual(summary1.cells_written, 11, 'only 11 cells written — the 26 non-matching human rows and 15 automated rows needed no write');

    const after = await repo.getRecords('COMMUNICATIONS', 'communication_id');
    const byId = Object.fromEntries(after.map((r) => [r.obj.communication_id, r.obj]));

    const expectedProactiveIds = ['com_hist_e0013', 'com_hist_e0015', 'com_hist_e0020', 'com_hist_e0022', 'com_hist_e0023', 'com_hist_e0026', 'com_hist_e0027', 'com_hist_e0029', 'com_hist_e0035', 'com_hist_e0037', 'com_hist_e0038'];
    for (const id of expectedProactiveIds) {
      assert.strictEqual(byId[id].contact_quality, 'proactive_booking_push', `${id} backfilled to proactive_booking_push`);
    }
    const expectedBlankIds = ['com_hist_e0008', 'com_hist_e0009', 'com_hist_e0010', 'com_hist_e0016', 'com_hist_e0021', 'com_hist_c0018', 'com_hist_c0012', 'com_hist_c0002'];
    for (const id of expectedBlankIds) {
      assert.strictEqual(byId[id].contact_quality, '', `${id} correctly stays blank`);
    }
    // Automated rows must never be touched by this backfill.
    for (const id of ['com_hist_e0011', 'com_hist_e0014', 'com_hist_e0025', 'com_hist_e0036']) {
      assert.strictEqual(byId[id].contact_quality, '', `${id} (automated) correctly left blank — only human rows are eligible`);
      assert.strictEqual(byId[id].automated_or_human, 'automated', `${id} automated_or_human untouched`);
    }
    // Nothing else on any row changed — spot-check a proactive row and a blank row.
    assert.strictEqual(byId['com_hist_e0020'].booking_attempt, '', 'backfill never writes booking_attempt (left exactly as seeded — never recomputed)');
    assert.strictEqual(byId['com_hist_e0020'].automated_or_human, 'human', 'backfill never touches automated_or_human');
    assert.strictEqual(byId['com_hist_e0020'].subject, 'Requested information for Bellhouse Avenue, South Ockendon, RM15', 'raw evidence columns untouched');

    ok('backfillContactQuality() against all 52 real historical rows: 11 proactive_booking_push, 26 human rows correctly left blank, 15 automated rows correctly skipped — nothing else on any row changed');

    console.log('\n  Historical rows backfilled to proactive_booking_push:');
    for (const id of expectedProactiveIds) {
      const row = byId[id];
      console.log(`    [${id}, ${row.channel}] "${(row.body_text || row.transcript).slice(0, 100)}…"`);
    }

    // ── Idempotency: re-running the backfill changes nothing further ──
    const summary2 = await backfillContactQuality(repo);
    assert.strictEqual(summary2.cells_written, 0, 'second run writes nothing — all 11 already have contact_quality set');
    assert.strictEqual(summary2.already_set, 11, 'second run correctly recognises the 11 as already set');
    ok('re-running the backfill is a no-op (idempotent) — safe to run more than once');

    __setRepoForTests(null);
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ SELFTEST FAILED:\n', err); process.exit(1); });
