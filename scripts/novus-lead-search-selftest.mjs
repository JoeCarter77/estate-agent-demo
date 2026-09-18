#!/usr/bin/env node
// scripts/novus-lead-search-selftest.mjs — hermetic test of the shared lead
// lookup (lib/lead-search.mjs) and incoming-callback recognition
// (lib/calling-inbound.mjs): phone normalisation, the ⌘K search, phone match
// ranking, and the full inbound flow through the real handlers — ring →
// overlay read → handoff re-ring → answer → normal calling-save on the same
// row. In-memory workbook, signed fake Twilio webhooks, no network.
//
// Run:  npm run novus:lead-search-selftest

import assert from 'node:assert/strict';
import { createRepo, __setRepoForTests } from '../lib/sheets.mjs';
import { ACTIONS_HEADER } from '../lib/actions-store.mjs';
import { CALLS_HEADER, SCRIPTS_HEADER, OBJECTIONS_HEADER, CALL_OBJECTION_EVENTS_HEADER } from '../lib/calling-store.mjs';
import { computeTwilioSignature } from '../lib/twilio-signature.mjs';
import {
  normalizePhoneNumber, phoneDigits, looksLikePhone, formatPhoneForDisplay, buildLeadIndex, searchLeads, findLeadsByPhone, rankPhoneMatches, invalidateLeadIndex,
} from '../lib/lead-search.mjs';
import { planInboundDialAction, ringTwimlBody, voicemailTwimlBody, MAX_RING_ATTEMPTS } from '../lib/calling-inbound.mjs';

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

process.env.NOVUS_BASIC_AUTH_USER = 'u'; process.env.NOVUS_BASIC_AUTH_PASS = 'p';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'authtok'; process.env.TWILIO_API_KEY_SID = 'SKtest'; process.env.TWILIO_API_KEY_SECRET = 'secret';
process.env.TWILIO_TWIML_APP_SID = 'APtest'; process.env.TWILIO_CALLER_ID = '+447700900000'; process.env.NOVUS_PUBLIC_BASE_URL = 'https://novus.test';
process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'sheet';

const T0 = Date.parse('2026-09-18T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const table = (header, objs) => ({ header: [...header], rows: objs.map((o) => header.map((k) => o[k] ?? '')) });
const callRow = (o) => ({ ...Object.fromEntries(CALLS_HEADER.map((k) => [k, ''])), call_mode: 'TWILIO', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), ...o });
const actionRow = (o) => ({ ...Object.fromEntries(ACTIONS_HEADER.map((k) => [k, ''])), action_owner: 'JOE', action_status: 'PENDING', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY), metadata_json: '{}', ...o });

// ── 1. phone normalisation ─────────────────────────────────────────────────
{
  const forms = ['07700900123', '07700 900123', '+447700900123', '447700900123', '07700-900-123', '0044 7700 900123', '+44 (0)7700 900123', '(07700) 900 123', '7700 900123', '+44 7700 900 123 ext 12'];
  for (const f of forms) assert.equal(normalizePhoneNumber(f), '+447700900123', f);
  assert.equal(normalizePhoneNumber('01277 123456'), '+441277123456');
  assert.equal(normalizePhoneNumber('020 7123 4567'), '+442071234567');
  assert.equal(normalizePhoneNumber('+1 212 555 1234'), '+12125551234');
  assert.equal(normalizePhoneNumber(''), ''); assert.equal(normalizePhoneNumber('n/a'), ''); assert.equal(normalizePhoneNumber('123'), '');
  ok('every written form of a UK number normalises to one E.164 value; junk normalises to nothing');
  assert.equal(phoneDigits('01277 123'), '441277123'); assert.equal(phoneDigits('+44 1277 123'), '441277123');
  assert.equal(looksLikePhone('1277'), true); assert.equal(looksLikePhone('church'), false); assert.equal(looksLikePhone('12'), false);
  assert.equal(formatPhoneForDisplay('+441277123456'), '01277 123456'); assert.equal(formatPhoneForDisplay('+447700900123'), '07700 900123'); assert.equal(formatPhoneForDisplay('+442071234567'), '020 7123 4567');
  ok('partial-number digits fold 0… and +44… onto the same prefix; caller ids format as UK numbers');
}

// ── 2. the index + free-text search ────────────────────────────────────────
const AG = ['agency_id', 'clean_agency_name', 'agency_name', 'main_phone', 'known_phone_numbers', 'outreach_contact_name', 'outreach_contact_email', 'website', 'location', 'current_pipeline_status', 'suppression_status'];
const agencies = [
  { agency_id: 'ag_ch', clean_agency_name: 'Church & Hawes', agency_name: 'Church and Hawes Estate Agents', main_phone: '01277 123456', outreach_contact_name: 'Mark Smith', outreach_contact_email: 'mark@churchandhawes.co.uk', website: 'https://www.churchandhawes.co.uk', location: 'Billericay' },
  // A second import of the same office (different source, separate record).
  { agency_id: 'ag_ch2', clean_agency_name: 'Church & Hawes Lettings', main_phone: '01277 123456', outreach_contact_name: '', location: 'Billericay' },
  { agency_id: 'ag_sw', clean_agency_name: 'Switchboard Homes', main_phone: '0208 000 1111', known_phone_numbers: '020 8000 1112; 07700 900999', outreach_contact_name: 'Priya Patel', location: 'Romford' },
  { agency_id: 'ag_qt', clean_agency_name: 'Quiet Estates', main_phone: '', outreach_contact_name: 'Team', location: 'Chelmsford' },
];
const contacts = [
  { contact_id: 'ct_1', agency_id: 'ag_ch', contact_name: 'Mark Smith', contact_role: 'Owner', email: 'mark@churchandhawes.co.uk', is_selected_for_outreach: 'TRUE', mobile: '07700 900123' },
  { contact_id: 'ct_2', agency_id: 'ag_ch', contact_name: 'Jo Bloggs', contact_role: 'Negotiator', email: '', is_selected_for_outreach: 'FALSE', mobile: '' },
];
const probes = [
  { probe_id: 'p_ch', agency_id: 'ag_ch', probe_status: 'CLOSED', probe_timestamp: iso(T0 - 6 * DAY), property_address: '14 Example Road, Billericay, CM12 9AA', enquiry_text: 'We are also thinking of selling our current house in Stock Road.' },
  { probe_id: 'p_sw', agency_id: 'ag_sw', probe_status: 'OBSERVING', probe_timestamp: iso(T0 - 2 * DAY), property_address: '3 Rise Park Avenue, Romford', enquiry_text: '' },
];
const baseTables = () => ({
  AGENCIES: table(AG, agencies),
  CONTACTS: table(['contact_id', 'agency_id', 'contact_name', 'contact_role', 'email', 'is_selected_for_outreach', 'mobile'], contacts),
  PROBES: table(['probe_id', 'agency_id', 'probe_status', 'probe_timestamp', 'property_address', 'enquiry_text'], probes),
  CALLS: table(CALLS_HEADER, []), ACTIONS: table(ACTIONS_HEADER, []),
  INTELLIGENCE: table(['intelligence_id', 'agency_id', 'grade', 'grade_reason', 'updated_at'], [{ intelligence_id: 'i1', agency_id: 'ag_ch', grade: 'C', grade_reason: 'Responded on the property, seller signal not picked up.', updated_at: iso(T0 - DAY) }]),
  DIAGNOSIS: table(['diagnosis_id', 'agency_id', 'handling_summary', 'diagnosis_summary', 'updated_at'], [{ diagnosis_id: 'd1', agency_id: 'ag_ch', handling_summary: 'Seller signal was included in the original enquiry. Agency responded regarding the property but the seller signal was not picked up.', updated_at: iso(T0 - DAY) }]),
});
{
  const index = buildLeadIndex(baseTables(), { now: iso(T0) });
  assert.equal(index.length, 4);
  const ch = index.find((e) => e.agency_id === 'ag_ch');
  assert.deepEqual(ch.phones.map((p) => `${p.source}:${p.e164}`), ['AGENCY_MAIN:+441277123456', 'CONTACT:+447700900123']);
  assert.equal(ch.contact_name, 'Mark Smith'); assert.equal(ch.contact_role, 'Owner'); assert.equal(ch.property, '14 Example Road');
  assert.match(ch.summary, /Seller signal was included/); assert.equal(ch.domain, 'churchandhawes.co.uk');
  assert.equal(ch.last_activity.kind, 'probe');
  const sw = index.find((e) => e.agency_id === 'ag_sw');
  assert.deepEqual(sw.phones.map((p) => p.e164), ['+442080001111', '+442080001112', '+447700900999'], 'every *phone* column, list-split');
  ok('the index reads every phone column on AGENCIES and CONTACTS, the selected contact, the probe property and the diagnosis summary');

  const ids = (q) => searchLeads(index, q, { nowMs: T0 }).map((r) => r.agency_id);
  assert.deepEqual(ids('01277123456'), ['ag_ch', 'ag_ch2'], 'a pasted number with no spaces finds both records holding it');
  assert.deepEqual(ids('+44 1277 123456'), ['ag_ch', 'ag_ch2']);
  assert.deepEqual(ids('07700 900123'), ['ag_ch']);
  assert.equal(searchLeads(index, '07700900123', { nowMs: T0 })[0].contact_name, 'Mark Smith', "a contact's mobile surfaces that contact");
  assert.deepEqual(ids('123456'), ['ag_ch', 'ag_ch2'], 'a partial number (last digits) narrows the list');
  assert.deepEqual(ids('1277 12'), ['ag_ch', 'ag_ch2'], 'a half-typed number matches by digit prefix');
  ok('phone search: all written forms, partials and contact mobiles resolve through the same normaliser');

  assert.deepEqual(ids('14 Example Road'), ['ag_ch'], 'property address');
  assert.deepEqual(ids('example road'), ['ag_ch']);
  assert.deepEqual(ids('Church & Hawes'), ['ag_ch', 'ag_ch2'], 'all records for the agency, best first');
  assert.deepEqual(ids('church hawes'), ['ag_ch', 'ag_ch2'], 'ampersand / "and" folded');
  assert.deepEqual(ids('mark'), ['ag_ch']); assert.deepEqual(ids('bloggs'), ['ag_ch'], 'a non-selected contact still finds the lead');
  assert.deepEqual(ids('billericay'), ['ag_ch', 'ag_ch2']); assert.deepEqual(ids('churchandhawes.co.uk'), ['ag_ch']);
  assert.deepEqual(ids('mark@churchandhawes'), ['ag_ch']); assert.deepEqual(ids('ag_sw'), ['ag_sw'], 'lead id');
  assert.deepEqual(ids('stock road'), ['ag_ch'], 'enquiry text');
  assert.deepEqual(ids('mark romford'), [], 'every typed word must match the same lead');
  assert.deepEqual(ids('zzz'), []);
  const r = searchLeads(index, 'church', { nowMs: T0 })[0];
  assert.equal(r.agency_name, 'Church & Hawes'); assert.equal(r.phone, '01277 123456'); assert.equal(r.property, '14 Example Road'); assert.ok(r.matched_on.includes('agency'));
  ok('text search covers agency, contact, email, domain, location, property, enquiry text and lead id; results carry the display fields');
}

// ── 3. phone match ranking ─────────────────────────────────────────────────
{
  const tables = baseTables();
  tables.CALLS = table(CALLS_HEADER, [
    callRow({ call_id: 'c_ch', agency_id: 'ag_ch', phone: '01277 123456', started_at: iso(T0 - 45 * MIN), outcome: 'NO_ANSWER', connected: 'FALSE' }),
    callRow({ call_id: 'c_ch2', agency_id: 'ag_ch2', phone: '01277 123456', started_at: iso(T0 - 20 * DAY), outcome: 'GATEKEPT', connected: 'TRUE' }),
  ]);
  tables.ACTIONS = table(ACTIONS_HEADER, [actionRow({ action_id: 'a1', agency_id: 'ag_ch', action_type: 'RETRY_CALL', due_at: iso(T0 + DAY), metadata_json: JSON.stringify({ call_action: true }) })]);
  const index = buildLeadIndex(tables, { now: iso(T0) });
  const ranked = rankPhoneMatches(findLeadsByPhone(index, '+441277123456'), { nowMs: T0 });
  assert.deepEqual(ranked.map((m) => m.agency_id), ['ag_ch', 'ag_ch2']);
  assert.equal(ranked[0].preselected, true, 'called 45 minutes ago → overwhelmingly likely');
  assert.match(ranked[0].reasons.join(' | '), /Called 45 min ago · no answer/); assert.match(ranked[0].reasons.join(' | '), /Callback expected/);
  assert.equal(ranked[1].preselected, undefined);
  assert.equal(ranked[0].last_activity.label, 'Called 45 min ago · no answer');
  ok('the lead called 45 minutes ago outranks a stale duplicate on the same number and is preselected; nothing is merged');

  const cold = rankPhoneMatches(findLeadsByPhone(buildLeadIndex(baseTables(), { now: iso(T0) }), '01277 123456'), { nowMs: T0 });
  assert.equal(cold.length, 2); assert.equal(cold[0].preselected, false, 'two never-called records on one number: Joe chooses');
  assert.equal(findLeadsByPhone(index, '0800 000 0000').length, 0);
  const mobile = rankPhoneMatches(findLeadsByPhone(index, '07700900123'), { nowMs: T0 });
  assert.equal(mobile.length, 1); assert.equal(mobile[0].contact_name, 'Mark Smith'); assert.equal(mobile[0].matched_source, 'CONTACT');
  const known = findLeadsByPhone(index, '+447700900999');
  assert.equal(known[0].agency_id, 'ag_sw'); assert.equal(known[0].matched_number, '07700 900999');
  ok('ambiguous switchboards stay ambiguous; contact mobiles and known_phone_numbers match; unknown numbers match nothing');
}

// ── 4. dial-action decisions (pure) ────────────────────────────────────────
{
  const row = (inbound) => ({ metadata_json: JSON.stringify({ direction: 'INBOUND', inbound }) });
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0) }), { status: 'completed', nowMs: T0 + 90_000 }).action, 'hangup');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), declined_at: iso(T0 + 5000) }), { status: 'busy', nowMs: T0 + 6000 }).result, 'declined');
  const handoff = planInboundDialAction(row({ ring_started_at: iso(T0), attempts: 1, handoff: { at: iso(T0 + 5000) } }), { status: 'busy', nowMs: T0 + 6000 });
  assert.equal(handoff.action, 'ring'); assert.equal(handoff.greet, 'Connecting you now.');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), attempts: 3, handoff: { at: iso(T0 + 5000) }, handoff_rings: 1 }), { status: 'failed', nowMs: T0 + 9000 }).greet, '', 'the caller hears "connecting" once');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), attempts: 1, handoff: { at: iso(T0 + 5000) } }), { status: 'no-answer', nowMs: T0 + 5000 + 80_000 }).action, 'voicemail', 'a stale handoff is not retried forever');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), attempts: 1 }), { status: 'failed', nowMs: T0 + 3000 }).action, 'ring', 'client not registered / page refreshed → ring again');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), attempts: MAX_RING_ATTEMPTS }), { status: 'failed', nowMs: T0 + 3000 }).action, 'voicemail', 'bounded');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), attempts: 1 }), { status: 'no-answer', nowMs: T0 + 26_000 }).result, 'missed');
  assert.equal(planInboundDialAction(row({ ring_started_at: iso(T0), attempts: 1 }), { status: 'busy', nowMs: T0 + 2000 }).result, 'busy', 'already on a call → the SDK rejects → voicemail, never a second ring');
  assert.match(ringTwimlBody({ callId: 'cal_x', from: '+441277123456' }), /<Dial timeout="25" answerOnBridge="true" action="https:\/\/novus.test\/api\/novus\/webhooks\/voice-inbound-action"/);
  assert.match(ringTwimlBody({ callId: 'cal_x', from: '+441277123456' }), /<Client statusCallback="https:\/\/novus.test\/api\/novus\/webhooks\/voice-outbound-status"[^>]*><Identity>novus-operator<\/Identity><Parameter name="call_id" value="cal_x"\/>/);
  assert.match(voicemailTwimlBody(), /<Record maxLength="120"[^>]*recordingStatusCallback="https:\/\/novus.test\/api\/novus\/webhooks\/voice-recording"/);
  ok('dial-action plan: answered → hang up; declined → voicemail; handoff/refresh → bounded re-ring; busy → voicemail; TwiML rings the browser identity with the call_id attached');
}

// ── 5. the whole flow through the real handlers ────────────────────────────
function makeStore(initial) {
  const store = structuredClone(initial);
  const api = {
    async get(range) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`Unable to parse range: ${tab}`); return store[tab].map((r) => r.slice()); },
    async append(range, rows) { const tab = String(range).split('!')[0]; if (!(tab in store)) throw new Error(`no tab ${tab}`); store[tab].push(...rows.map((r) => r.slice())); },
    async update(range, rows) {
      const [tab, a1] = String(range).split('!');
      const m = a1.match(/^([A-Z]+)(\d+)/);
      const colIdx = m[1].split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
      const rowIdx = Number(m[2]) - 1;
      rows.forEach((row, i) => {
        while (store[tab].length <= rowIdx + i) store[tab].push([]);
        const target = store[tab][rowIdx + i];
        row.forEach((v, j) => { while (target.length <= colIdx + j) target.push(''); target[colIdx + j] = v; });
      });
    },
    async batchUpdate(data) { for (const { range, values } of data) await api.update(range, values); },
    async listTabs() { return Object.keys(store); },
    async addTab(tab) { store[tab] = []; },
    async deleteRows(tab, rowNumbers) { for (const n of [...new Set(rowNumbers)].sort((a, b) => b - a)) store[tab].splice(n - 1, 1); },
  };
  return { store, repo: createRepo(api) };
}
const RAW_EVENTS_HEADER = ['raw_event_id', 'provider', 'provider_event_id', 'channel', 'event_type', 'received_at', 'occurred_at', 'source_identifier', 'destination_identifier', 'payload_reference', 'processing_status', 'processed_communication_id', 'error_message', 'created_at'];
const COMMUNICATIONS_HEADER = ['communication_id', 'agency_id', 'probe_id', 'interaction_id', 'occurred_at', 'received_at', 'channel', 'direction', 'communication_type', 'provider', 'provider_event_id', 'source_identifier_raw', 'source_identifier_normalized', 'destination_identifier', 'display_name', 'call_status', 'duration_seconds', 'voicemail_present', 'recording_reference', 'transcript', 'raw_payload_reference', 'matching_method', 'match_score', 'match_status', 'automated_or_human', 'human_contact', 'callback_attempt', 'successful_conversation', 'follow_up', 'booking_attempt', 'communication_classification', 'manual_review_status', 'created_at', 'updated_at'];
{
  const t = baseTables();
  const rows = (tbl) => [tbl.header, ...tbl.rows];
  const { store, repo } = makeStore({
    AGENCIES: rows(t.AGENCIES), CONTACTS: rows(t.CONTACTS), INTELLIGENCE: rows(t.INTELLIGENCE), DIAGNOSIS: rows(t.DIAGNOSIS),
    PROBES: rows(table(['probe_id', 'agency_id', 'probe_status', 'probe_timestamp', 'observation_deadline', 'property_address', 'enquiry_text', 'compromised'], probes.map((p) => ({ ...p, observation_deadline: iso(T0 + 30 * DAY) })))),
    CALLS: rows(table(CALLS_HEADER, [callRow({ call_id: 'c_prev', agency_id: 'ag_ch', phone: '01277 123456', started_at: iso(Date.now() - 45 * MIN), outcome: 'NO_ANSWER', connected: 'FALSE', script_id: 'scr_1' })])),
    ACTIONS: rows(table(ACTIONS_HEADER, [actionRow({ action_id: 'a_retry', agency_id: 'ag_ch', action_type: 'RETRY_CALL', due_at: iso(Date.now() + DAY), metadata_json: JSON.stringify({ call_action: true, call_id: 'c_prev' }) })])),
    SCRIPTS: rows(table(SCRIPTS_HEADER, [{ script_id: 'scr_1', script_key: 'k', name: 'Seller Opportunity', version: 1, status: 'CURRENT', content: 'Hi {{first_name}}', created_at: iso(T0 - DAY), updated_at: iso(T0 - DAY) }])),
    OBJECTIONS: rows(table(OBJECTIONS_HEADER, [])), CALL_OBJECTION_EVENTS: rows(table(CALL_OBJECTION_EVENTS_HEADER, [])),
    RAW_EVENTS: [RAW_EVENTS_HEADER], COMMUNICATIONS: [COMMUNICATIONS_HEADER], REPLY_EVENTS: [['reply_event_id', 'agency_id']], DEMOS: [['demo_id', 'agency_id']],
  });
  __setRepoForTests(repo);
  invalidateLeadIndex();
  const { default: personalisation } = await import('../api/novus/personalisation.js');
  const { default: voiceInbound } = await import('../api/novus/webhooks/voice-inbound.js');
  const auth = { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` };
  const mockRes = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const call = async (method, op, body, query = {}) => { const r = mockRes(); await personalisation({ method, query: { novus_operation: op, ...query }, headers: auth, body }, r); return r; };
  const signed = (path, params) => ({ 'x-twilio-signature': computeTwilioSignature('authtok', `https://novus.test${path}`, params) });
  const inbound = async (params) => { const r = mockRes(); await voiceInbound({ method: 'POST', query: {}, headers: signed('/api/novus/webhooks/voice-inbound', params), body: params }, r); return r; };
  const dialAction = async (params) => { const r = mockRes(); await personalisation({ method: 'POST', query: { novus_operation: 'twilio-voice-inbound-action' }, headers: signed('/api/novus/webhooks/voice-inbound-action', params), body: params }, r); return r; };
  const callsRow = (id) => { const r = store.CALLS.find((x) => x[0] === id); return r ? Object.fromEntries(CALLS_HEADER.map((k, i) => [k, String(r[i] ?? '')])) : null; };
  const meta = (id) => JSON.parse(callsRow(id).metadata_json || '{}');

  // Search operation.
  let res = await call('GET', 'lead-search', null, { q: '01277123456' });
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.results.map((r) => r.agency_id), ['ag_ch', 'ag_ch2']);
  assert.equal(res.body.results[0].last_activity.label.startsWith('Called 45 min ago'), true);
  res = await call('GET', 'lead-search', null, { q: 'Church & Hawes' });
  assert.deepEqual(res.body.results.map((r) => r.agency_id), ['ag_ch', 'ag_ch2']);
  res = await call('GET', 'lead-search', null, { q: '14 Example Road' });
  assert.deepEqual(res.body.results.map((r) => r.agency_id), ['ag_ch']);
  const denied = mockRes(); await personalisation({ method: 'GET', query: { novus_operation: 'lead-search', q: 'x' }, headers: {} }, denied);
  assert.equal(denied.statusCode, 401);
  ok('lead-search operation: number, agency and property all find Mark; Basic Auth enforced');

  // Mark calls back. Unsigned → 401 and nothing written.
  const params = { CallSid: 'CAin1', From: '+441277123456', To: '+447575333064', CallStatus: 'ringing' };
  let r = mockRes(); await voiceInbound({ method: 'POST', query: {}, headers: {}, body: params }, r);
  assert.equal(r.statusCode, 401); assert.equal(store.CALLS.length, 2);
  res = await inbound(params);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<Dial timeout="25" answerOnBridge="true" action="https:\/\/novus.test\/api\/novus\/webhooks\/voice-inbound-action"/);
  assert.match(res.body, /<Identity>novus-operator<\/Identity><Parameter name="call_id" value="(cal_[a-z0-9_]+)"\/>/);
  const callId = res.body.match(/name="call_id" value="(cal_[a-z0-9_]+)"/)[1];
  assert.equal(store.RAW_EVENTS.length, 2); assert.equal(store.COMMUNICATIONS.length, 2, 'the evidence rows are written exactly as before');
  assert.equal(store.COMMUNICATIONS[1][COMMUNICATIONS_HEADER.indexOf('source_identifier_normalized')], '+441277123456');
  assert.equal(store.COMMUNICATIONS[1][COMMUNICATIONS_HEADER.indexOf('match_status')], 'ambiguous', 'the existing (protected) probe matcher still runs and still refuses to guess between two records on one number');
  let row = callsRow(callId);
  assert.equal(row.agency_id, 'ag_ch', 'preselected: called 45 minutes ago'); assert.equal(row.contact_name, 'Mark Smith'); assert.equal(row.phone, '01277 123456');
  assert.equal(row.call_status, 'ringing'); assert.equal(row.twilio_call_sid, 'CAin1'); assert.equal(row.call_mode, 'TWILIO');
  assert.equal(meta(callId).direction, 'INBOUND'); assert.equal(meta(callId).inbound.candidates.length, 2); assert.equal(meta(callId).inbound.candidates[0].preselected, true);
  assert.equal(meta(callId).inbound.communication_id, store.COMMUNICATIONS[1][0]);
  ok('inbound webhook: evidence written as before, then a CALLS row opens (INBOUND, Mark preselected) and the browser identity is rung with the call_id');

  res = await inbound(params);
  assert.match(res.body, new RegExp(`name="call_id" value="${callId}"`)); assert.equal(store.CALLS.length, 3);
  ok('a Twilio retry of the same CallSid rings the same call, opening nothing new');

  // The overlay reads it.
  res = await call('GET', 'calling-inbound', null, { call_id: callId });
  assert.equal(res.statusCode, 200); assert.equal(res.body.caller.display, '01277 123456'); assert.equal(res.body.caller.e164, '+441277123456');
  assert.equal(res.body.candidates.length, 2); assert.equal(res.body.candidates[0].agency_id, 'ag_ch'); assert.equal(res.body.candidates[0].preselected, true);
  assert.equal(res.body.candidates[0].contact_role, 'Owner'); assert.equal(res.body.candidates[0].property, '14 Example Road');
  assert.match(res.body.candidates[0].summary, /seller signal was not picked up/); assert.match(res.body.candidates[0].last_activity.label, /^Called 45 min ago/);
  assert.match(res.body.candidates[0].reasons.join(' '), /Callback expected/);
  assert.equal(res.body.linked_lead.agency_id, 'ag_ch');
  ok('calling-inbound returns the caller, the ranked candidates with role / property / last call / summary, and the preselection');

  // Joe is on another page: handoff → the browser rejects the ring → Twilio hits the Dial action → ring again.
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId, intent: 'handoff', agency_id: 'ag_ch', contact_name: 'Mark Smith', contact_role: 'Owner', script_id: 'scr_1' });
  assert.equal(res.statusCode, 200); assert.equal(meta(callId).inbound.handoff.agency_id, 'ag_ch');
  res = await dialAction({ CallSid: 'CAin1', DialCallStatus: 'busy' });
  assert.match(res.body, /<Say voice="alice">Connecting you now.<\/Say><Dial/); assert.match(res.body, new RegExp(`value="${callId}"`));
  assert.equal(meta(callId).inbound.attempts, 2); assert.equal(callsRow(callId).call_status, 'ringing');
  res = await dialAction({ CallSid: 'CAin1', DialCallStatus: 'failed' });
  assert.ok(!/Connecting you now/.test(res.body) && /<Dial /.test(res.body), 'second re-ring is silent (calling page still registering)');
  ok('handoff: the Dial action re-rings the browser instead of dropping to voicemail, greeting the caller once');

  // The calling page answers with the (possibly different) lead chosen.
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId, intent: 'answer', agency_id: 'ag_ch', contact_name: 'Mark Smith', contact_role: 'Owner', script_id: 'scr_1' });
  assert.equal(res.statusCode, 200); row = callsRow(callId);
  assert.equal(row.call_status, 'in-progress'); assert.ok(row.connected_at); assert.equal(row.script_id, 'scr_1'); assert.equal(String(row.attempt_number), '2');
  assert.equal(meta(callId).inbound.result, 'answered');
  res = await call('GET', 'calling-workspace', null, { refresh: '1' });
  assert.equal(res.body.leads.ag_ch.attempts, 1, 'an open inbound call is not yet an attempt');
  ok('answer: the row is stamped in-progress / connected with the chosen lead and script before the conversation starts');

  // The <Client> leg's status events reuse the outbound status handler (same parent CallSid).
  r = mockRes(); await personalisation({ method: 'POST', query: { novus_operation: 'twilio-voice-status' }, headers: signed('/api/novus/webhooks/voice-outbound-status', { CallSid: 'CAclient', ParentCallSid: 'CAin1', CallStatus: 'completed', CallDuration: '140' }), body: { CallSid: 'CAclient', ParentCallSid: 'CAin1', CallStatus: 'completed', CallDuration: '140' } }, r);
  assert.equal(callsRow(callId).duration_seconds, '140'); assert.ok(callsRow(callId).ended_at);
  res = await dialAction({ CallSid: 'CAin1', DialCallStatus: 'completed', DialCallDuration: '140' });
  assert.match(res.body, /<Hangup\/>/); assert.equal(callsRow(callId).call_status, 'completed');
  r = mockRes(); const rec = { CallSid: 'CAin1', RecordingSid: 'REin', RecordingUrl: 'https://api.twilio.com/x', RecordingStatus: 'completed', RecordingDuration: '138' };
  await personalisation({ method: 'POST', query: { novus_operation: 'twilio-voice-recording' }, headers: signed('/api/novus/webhooks/voice-outbound-recording', rec), body: rec }, r);
  assert.equal(callsRow(callId).recording_sid, 'REin'); assert.equal(callsRow(callId).recording_url, '');
  ok('the existing status + recording webhooks land on the inbound row through the parent CallSid; the Dial action hangs up an answered call');

  // The NORMAL call screen saves it — same operation, same row, outcome + follow-ups against Mark's lead.
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', call_id: callId, agency_id: 'ag_ch', script_id: 'scr_1', contact_name: 'Mark Smith', phone: '01277 123456', call_mode: 'TWILIO', twilio_call_sid: 'CAin1',
    outcome: 'MORE_INFO_REQUESTED', more_info_type: 'DEMO', more_info_note: 'send the demo', owner_reach_source: 'DIRECT', owner_reached_at: iso(Date.now()), main_priority: 'VALUATIONS', useful_note: 'He called back himself' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.call.call_id, callId);
  row = callsRow(callId);
  assert.equal(row.outcome, 'MORE_INFO_REQUESTED'); assert.equal(row.agency_id, 'ag_ch'); assert.equal(row.recording_sid, 'REin'); assert.equal(row.duration_seconds, '140');
  assert.equal(meta(callId).direction, 'INBOUND'); assert.equal(meta(callId).inbound.result, 'answered'); assert.equal(meta(callId).followups, 'COMPLETE');
  assert.deepEqual(res.body.actions_created.map((a) => a.action_type).sort(), ['CALL_PROSPECT', 'SEND_INFORMATION']);
  assert.ok(res.body.actions_completed.includes('a_retry'), 'the pending retry for Mark is completed by his callback');
  res = await call('GET', 'calling-workspace', null, { refresh: '1' });
  assert.equal(res.body.leads.ag_ch.attempts, 2); assert.equal(res.body.leads.ag_ch.last_call.call_id, callId);
  res = await call('GET', 'lead-search', null, { q: 'church', refresh: '1' });
  assert.match(res.body.results[0].last_activity.label, /^Called back just now · more info requested/);
  ok('calling-save records the callback against Mark: outcome, follow-ups, completed retry, and the lead now shows "Called back"');

  // A second callback from the same number, this time nobody picks up → voicemail; the row stays out of "unclassified".
  res = await inbound({ CallSid: 'CAin2', From: '01277 123456', To: '+447575333064', CallStatus: 'ringing' });
  const callId2 = res.body.match(/name="call_id" value="(cal_[a-z0-9_]+)"/)[1];
  res = await dialAction({ CallSid: 'CAin2', DialCallStatus: 'no-answer' });
  assert.match(res.body, /<Record maxLength="120"/); assert.equal(callsRow(callId2).call_status, 'no-answer'); assert.equal(meta(callId2).inbound.result, 'missed');
  res = await call('GET', 'calling-analytics', null, { range: 'all', refresh: '1' });
  assert.equal(res.body.summary.unclassified, 0, 'a missed inbound ring is not an unclassified dial');
  res = await call('GET', 'calling-workspace', null, { refresh: '1' });
  assert.equal(res.body.leads.ag_ch.attempts, 2, 'a missed callback is not an attempt and does not move the queue');
  ok('a missed callback drops to voicemail, is recorded as missed on the lead, and never counts as a dial');

  // Decline.
  res = await inbound({ CallSid: 'CAin3', From: '07700 900123', To: '+447575333064', CallStatus: 'ringing' });
  const callId3 = res.body.match(/name="call_id" value="(cal_[a-z0-9_]+)"/)[1];
  assert.equal(callsRow(callId3).contact_name, 'Mark Smith', "Mark's mobile identifies him directly");
  await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId3, intent: 'decline' });
  res = await dialAction({ CallSid: 'CAin3', DialCallStatus: 'failed' });
  assert.match(res.body, /<Record /); assert.equal(meta(callId3).inbound.result, 'declined');
  ok('decline sends the caller to voicemail even where a failed dial would otherwise be retried');

  // Unknown caller → rings as unidentified, answered, linked to a lead mid-call, saved. The number then matches next time.
  res = await inbound({ CallSid: 'CAin4', From: '+441245999000', To: '+447575333064', CallStatus: 'ringing' });
  const callId4 = res.body.match(/name="call_id" value="(cal_[a-z0-9_]+)"/)[1];
  assert.equal(callsRow(callId4).agency_id, ''); assert.equal(callsRow(callId4).phone, '01245 999000');
  res = await call('GET', 'calling-inbound', null, { call_id: callId4 });
  assert.equal(res.body.candidates.length, 0); assert.equal(res.body.linked_lead, null);
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId4, intent: 'answer' });
  assert.equal(res.statusCode, 200); assert.equal(callsRow(callId4).call_status, 'in-progress'); assert.equal(callsRow(callId4).agency_id, '');
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId4, intent: 'link', agency_id: 'ag_qt', contact_name: 'Sam Quiet', contact_role: 'Director' });
  assert.equal(callsRow(callId4).agency_id, 'ag_qt'); assert.equal(callsRow(callId4).contact_name, 'Sam Quiet');
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId4, intent: 'link', agency_id: 'ag_missing' });
  assert.equal(res.statusCode, 404);
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', call_id: callId4, agency_id: 'ag_qt', call_mode: 'TWILIO', outcome: 'CALLBACK_REQUESTED', callback_at: iso(Date.now() + 2 * DAY), owner_reached: true });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(callsRow(callId4).outcome, 'CALLBACK_REQUESTED');
  res = await call('GET', 'lead-search', null, { q: '01245 999000', refresh: '1' });
  assert.deepEqual(res.body.results.map((x) => x.agency_id), ['ag_qt']); assert.equal(res.body.results[0].contact_name, 'Sam Quiet');
  res = await inbound({ CallSid: 'CAin5', From: '+441245999000', To: '+447575333064', CallStatus: 'ringing' });
  const callId5 = res.body.match(/name="call_id" value="(cal_[a-z0-9_]+)"/)[1];
  assert.equal(callsRow(callId5).agency_id, 'ag_qt', 'the linked number is recognised automatically next time, without touching AGENCIES');
  assert.equal(store.AGENCIES.find((x) => x[0] === 'ag_qt')[AG.indexOf('main_phone')], '', 'AGENCIES untouched');
  ok('unknown caller: rings as unidentified, can be linked to a lead during the call, saves normally, and is recognised on the next call');

  // Guard rails.
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: 'c_prev', intent: 'answer' });
  assert.equal(res.statusCode, 404, 'an outbound row is never an inbound call');
  res = await call('POST', 'calling-inbound-intent', { confirm: 'INBOUND_CALL', call_id: callId, intent: 'nope' });
  assert.equal(res.statusCode, 400);
  res = await call('POST', 'calling-save', { confirm: 'SAVE_CALL', call_id: 'c_prev', agency_id: 'ag_sw', call_mode: 'TWILIO', outcome: 'NO_ANSWER' });
  assert.equal(res.statusCode, 409, 'outbound rows still cannot change agency');
  ok('guard rails: outbound rows are untouched by the inbound operations and still cannot change agency');

  // Browser calling not configured → the old behaviour, untouched: straight to voicemail, no CALLS row.
  delete process.env.TWILIO_API_KEY_SID;
  const before = store.CALLS.length;
  res = await inbound({ CallSid: 'CAin6', From: '+441277123456', To: '+447575333064', CallStatus: 'ringing' });
  assert.match(res.body, /<Record maxLength="120"/); assert.ok(!/<Dial/.test(res.body)); assert.equal(store.CALLS.length, before);
  assert.equal(store.COMMUNICATIONS.length, 7, 'evidence still written');
  ok('without browser calling configured the inbound number behaves exactly as before (voicemail + evidence only)');
}

console.log(`\n✅ Lead search + inbound callback self-test passed (${passed} checks).`);
