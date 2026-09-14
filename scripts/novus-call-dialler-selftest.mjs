import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startOperatorCall, buildOperatorDialTwiml } from '../lib/operator-calls.mjs';
import { shouldAnalyseCall, _internal as callAiInternal } from '../lib/call-intelligence.mjs';

const appended = { RAW_EVENTS: [], COMMUNICATIONS: [] };
const repo = {
  async findById(tab, idColumn, idValue) {
    if (tab === 'AGENCIES' && idColumn === 'agency_id' && idValue === 'agy_test') {
      return { obj: { agency_id: 'agy_test', agency_name: 'Test & Co' } };
    }
    return null;
  },
  async appendRecord(tab, obj) {
    appended[tab].push(obj);
    return obj;
  },
};

let twilioRequest = null;
async function fakeFetch(url, init) {
  twilioRequest = { url, init };
  return {
    ok: true,
    status: 201,
    async json() { return { sid: 'CA1234567890abcdef', status: 'queued' }; },
  };
}

const env = {
  TWILIO_ACCOUNT_SID: 'AC1234567890abcdef',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_PHONE_NUMBER: '+447575333064',
  NOVUS_OPERATOR_PHONE: '+447700900111',
  NOVUS_CALLER_ID: '+447700900222',
};

const result = await startOperatorCall({
  repo,
  agencyId: 'agy_test',
  prospectPhone: '020 7123 4567',
  actionId: 'act_test',
  probeId: 'prb_test',
  contactName: 'Ian Owner',
  baseUrl: 'https://novus.example',
  fetchImpl: fakeFetch,
  env,
});

assert.equal(result.call_sid, 'CA1234567890abcdef');
assert.equal(result.prospect_phone, '+442071234567');
assert.equal(result.caller_id, '+447700900222');
assert.equal(appended.RAW_EVENTS.length, 1);
assert.equal(appended.COMMUNICATIONS.length, 1);
assert.equal(appended.COMMUNICATIONS[0].agency_id, 'agy_test');
assert.equal(appended.COMMUNICATIONS[0].direction, 'outbound');
assert.equal(appended.COMMUNICATIONS[0].communication_type, 'sales_call');
assert.equal(appended.COMMUNICATIONS[0].interaction_id, result.call_sid);
assert.equal(appended.COMMUNICATIONS[0].display_name, 'Ian Owner');
assert.equal(appended.COMMUNICATIONS[0].recording_reference, '');

assert.match(twilioRequest.url, /\/Calls\.json$/);
const form = new URLSearchParams(twilioRequest.init.body);
assert.equal(form.get('To'), '+447700900111', 'Twilio rings Joe/operator first');
assert.equal(form.get('From'), '+447575333064', 'initial leg comes from Twilio-owned number');
assert.match(form.get('Twiml'), /callerId="\+447700900222"/);
assert.match(form.get('Twiml'), /record="record-from-answer-dual"/);
assert.match(form.get('Twiml'), /<Number[^>]+statusCallback=/);
assert.match(form.get('Twiml'), />\+442071234567<\/Number>/);
assert.match(form.get('Twiml'), /https:\/\/novus\.example\/api\/novus\/webhooks\/voice-recording/);

const xml = buildOperatorDialTwiml({
  prospectPhone: '+442071234567',
  callerId: '+447700900222',
  callback: 'https://novus.example/api/novus/webhooks/voice-recording',
});
assert.match(xml, /^<\?xml/);
assert.match(xml, /record-from-answer-dual/);

assert.equal(shouldAnalyseCall(44, { NOVUS_CALL_AI_MIN_SECONDS: '45' }), false);
assert.equal(shouldAnalyseCall(45, { NOVUS_CALL_AI_MIN_SECONDS: '45' }), true);

const normalised = callAiInternal.normaliseAnalysis({
  decision_maker_reached: true,
  call_outcome: 'meeting_booked',
  meeting_booked: true,
  meeting_date: 'Thursday 11:30',
  interest_level: 'high',
  branches: '3',
  pain_points: ['database goes stale'],
  objections: ['another CRM'],
  summary: 'Useful owner conversation.',
  confidence: 1.4,
});
assert.equal(normalised.call_outcome, 'MEETING_BOOKED');
assert.equal(normalised.interest_level, 'HIGH');
assert.equal(normalised.branches, 3);
assert.equal(normalised.confidence, 1);

const operatorHtml = fs.readFileSync(new URL('../novus/operator.html', import.meta.url), 'utf8');
const personalisation = fs.readFileSync(new URL('../api/novus/personalisation.js', import.meta.url), 'utf8');
const voiceRecording = fs.readFileSync(new URL('../api/novus/webhooks/voice-recording.js', import.meta.url), 'utf8');

assert.match(operatorHtml, /novus_operation=operator-call-start/);
assert.match(operatorHtml, /novus_operation=operator-calls/);
assert.match(operatorHtml, /class="btn btn-primary btn-sm call-now"/);
assert.match(personalisation, /handleOperatorCallStart/);
assert.match(personalisation, /handleOperatorCalls/);
assert.match(voiceRecording, /processSalesCallIntelligence/);
assert.match(voiceRecording, /communication_type\)\.toLowerCase\(\) === 'sales_call'/);

console.log('NOVUS call dialler self-test passed');
