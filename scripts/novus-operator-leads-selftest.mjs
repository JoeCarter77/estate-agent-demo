// Hermetic focused tests for the PURE operator lead aggregator
// (lib/operator-leads.mjs) and for the read-only shape of the operator-leads
// API operation.
//
// No network, no Google credentials, no Instantly call, no AI call, no email
// send, no Sheets write. The API test below runs against an in-memory repo and
// ASSERTS that zero write methods were reached.
//
// Run: npm run novus:operator-leads-selftest

import assert from 'node:assert/strict';
import {
  buildOperatorLeads,
  deriveContactType,
  deriveCurrentState,
  deriveDecisionMakerConfidence,
  deriveDemoEngagement,
  deriveLatestEvent,
  deriveNeedsHuman,
  derivePriority,
  namesLikelySamePerson,
  selectPrimaryJourney,
  sortReplyEventsNewestFirst,
} from '../lib/operator-leads.mjs';
import { __setRepoForTests } from '../lib/sheets.mjs';
import personalisationHandler from '../api/novus/personalisation.js';

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }
function part(label) { console.log(`\n${label}`); }

// -- live-shaped headers -----------------------------------------------------

const OUTBOUND_HEADER = [
  'outbound_id', 'agency_id', 'probe_id', 'clean_agency_name',
  'outreach_contact_name', 'first_name', 'outreach_contact_email',
  'email_verification_status', 'property_street', 'probe_date', 'probe_time',
  'email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2',
  'demo_slug', 'demo_url', 'outbound_status', 'instantly_lead_id',
  'instantly_added_at', 'last_error', 'created_at', 'updated_at',
];
const REPLY_EVENTS_HEADER = [
  'reply_event_id', 'instantly_email_id', 'agency_id', 'outreach_id', 'lead_email',
  'campaign_id', 'thread_id', 'received_at', 'subject', 'body_text',
  'cleaned_reply_text', 'is_auto_reply', 'classification', 'confidence',
  'suppression_type', 'next_action', 'priority', 'processed_at', 'action_status',
  'action_completed_at', 'classifier_reason', 'error', 'notes',
];
const DEMOS_HEADER = [
  'demo_id', 'demo_slug', 'demo_status', 'agency_id', 'probe_id', 'probe_reference',
  'agency_name', 'grade', 'human_contact', 'response_hours', 'main_finding',
  'first_viewed_at', 'last_viewed_at', 'view_count', 'cta_clicked_at', 'meeting_booked_at',
];
const AGENCIES_HEADER = [
  'agency_id', 'agency_name', 'owner_md', 'outreach_contact_name',
  'outreach_contact_email', 'email_verification_status', 'contact_resolution_status',
];
const INTELLIGENCE_HEADER = [
  'intelligence_id', 'agency_id', 'probe_id', 'human_contact', 'response_hours',
  'grade', 'grade_reason',
];
const PERSONALISATION_HEADER = ['probe_id', 'agency_id', 'email_observation'];
const PROBES_HEADER = ['probe_id', 'probe_reference', 'agency_id', 'property_street', 'property_address'];

function table(header, objects) {
  return { header: header.slice(), rows: objects.map((obj) => header.map((c) => obj[c] ?? '')) };
}

// One well-formed workbook; each test overrides only what it is about.
function workbook({ outbound = [], replies = [], demos = [], agencies = [], intelligence = [], personalisation = [], probes = [] } = {}) {
  return {
    OUTBOUND: table(OUTBOUND_HEADER, outbound),
    REPLY_EVENTS: table(REPLY_EVENTS_HEADER, replies),
    DEMOS: table(DEMOS_HEADER, demos),
    AGENCIES: table(AGENCIES_HEADER, agencies),
    INTELLIGENCE: table(INTELLIGENCE_HEADER, intelligence),
    PERSONALISATION: table(PERSONALISATION_HEADER, personalisation),
    PROBES: table(PROBES_HEADER, probes),
  };
}

const baseOutbound = {
  outbound_id: 'out_1', agency_id: 'ag_1', probe_id: 'prb_1',
  clean_agency_name: 'Stanton Hockett', outreach_contact_name: 'Bradley Stanton',
  outreach_contact_email: 'bradley@stanton.co.uk', email_verification_status: 'VALID',
  property_street: '10 High Street', demo_slug: 'stanton-high-street',
  demo_url: 'https://demo.getnovus.co.uk/stanton-high-street',
  outbound_status: 'SENT', instantly_lead_id: 'lead_abc',
  instantly_added_at: '2026-08-20T09:00:00.000Z', updated_at: '2026-08-20T09:00:00.000Z',
};

const NOW = '2026-09-02T12:00:00.000Z';

function firstLead(tables) {
  const built = buildOperatorLeads(tables, { now: NOW });
  return { lead: built.leads[0], built };
}

// ---------------------------------------------------------------------------
part('A. current_state precedence');
// ---------------------------------------------------------------------------

const stateCases = [
  ['MEETING_BOOKED beats everything', {
    demo: { meeting_booked_at: '2026-09-01T10:00:00.000Z', cta_clicked_at: '2026-08-31T10:00:00.000Z' },
    replyEvents: [{ classification: 'NOT_INTERESTED', suppression_type: 'PERMANENT' }],
  }, 'MEETING_BOOKED'],
  ['OPTED_OUT beats NOT_INTERESTED', {
    replyEvents: [{ classification: 'NOT_INTERESTED', suppression_type: 'PERMANENT' }],
  }, 'OPTED_OUT'],
  ['NOT_INTERESTED', { replyEvents: [{ classification: 'NOT_INTERESTED' }] }, 'NOT_INTERESTED'],
  ['NOT_NOW becomes NURTURE', { replyEvents: [{ classification: 'NOT_NOW' }] }, 'NURTURE'],
  ['cta_clicked_at gives DEMO_ENGAGED without any send evidence', {
    demo: { cta_clicked_at: '2026-08-30T10:00:00.000Z' },
    replyEvents: [{ classification: 'QUESTION' }],
  }, 'DEMO_ENGAGED'],
  ['view AFTER a recorded send gives DEMO_ENGAGED', {
    demo: { first_viewed_at: '2026-08-30T12:00:00.000Z' },
    replyEvents: [{
      classification: 'POSITIVE_SEND_DEMO', next_action: 'SEND_DEMO', action_status: 'COMPLETED',
      action_completed_at: '2026-08-30T10:00:00.000Z', notes: 'SEND_DEMO sent instantly_email_id=e1',
    }],
  }, 'DEMO_ENGAGED'],
  ['view BEFORE the send stays DEMO_SENT (could be our own pre-send check)', {
    demo: { first_viewed_at: '2026-08-29T08:00:00.000Z' },
    replyEvents: [{
      classification: 'POSITIVE_SEND_DEMO', next_action: 'SEND_DEMO', action_status: 'COMPLETED',
      action_completed_at: '2026-08-30T10:00:00.000Z', notes: 'SEND_DEMO sent instantly_email_id=e1',
    }],
  }, 'DEMO_SENT'],
  ['a view with NO send evidence is not engagement', {
    demo: { first_viewed_at: '2026-08-29T08:00:00.000Z', view_count: '3' },
    replyEvents: [{ classification: 'QUESTION', next_action: 'HUMAN_REPLY', action_status: 'PENDING' }],
  }, 'REPLIED'],
  ['SEND_DEMO COMPLETED gives DEMO_SENT', {
    replyEvents: [{
      next_action: 'SEND_DEMO', action_status: 'COMPLETED',
      action_completed_at: '2026-08-30T10:00:00.000Z', notes: 'SEND_DEMO sent instantly_email_id=e1',
    }],
  }, 'DEMO_SENT'],
  ['SEND_DEMO PENDING is NOT send evidence', {
    replyEvents: [{ next_action: 'SEND_DEMO', action_status: 'PENDING' }],
  }, 'REPLIED'],
  ['action_status REVIEW gives REVIEW_REQUIRED', {
    replyEvents: [{ classification: 'QUESTION', action_status: 'REVIEW' }],
  }, 'REVIEW_REQUIRED'],
  ['action_status FAILED gives REVIEW_REQUIRED', {
    replyEvents: [{ classification: 'QUESTION', action_status: 'FAILED' }],
  }, 'REVIEW_REQUIRED'],
  ['next_action MANUAL_REVIEW gives REVIEW_REQUIRED', {
    replyEvents: [{ classification: 'OTHER_UNCLEAR', next_action: 'MANUAL_REVIEW', action_status: 'PENDING' }],
  }, 'REVIEW_REQUIRED'],
  ['a plain reply gives REPLIED', {
    replyEvents: [{ classification: 'OOO_AUTOMATED', next_action: 'NONE', action_status: 'NO_ACTION' }],
  }, 'REPLIED'],
  ['instantly_lead_id with no reply gives SEQUENCE_RUNNING', {
    outbound: { instantly_lead_id: 'lead_abc', outbound_status: 'SENT' },
  }, 'SEQUENCE_RUNNING'],
  ['READY with no lead id', {
    outbound: { instantly_lead_id: '', outbound_status: 'READY' },
  }, 'READY'],
  ['SUPPRESSED with no lead id is UNKNOWN, never mislabelled READY', {
    outbound: { instantly_lead_id: '', outbound_status: 'SUPPRESSED' },
  }, 'UNKNOWN'],
];

for (const [label, input, expected] of stateCases) {
  const { state } = deriveCurrentState({
    outbound: { outbound_status: 'SENT', instantly_lead_id: 'lead_abc', ...(input.outbound || {}) },
    replyEvents: input.replyEvents || [],
    demo: input.demo || null,
  });
  assert.equal(state, expected, `${label}: expected ${expected}, got ${state}`);
  ok(label);
}

{
  // Precedence is decided by the LATEST reply, not by any reply.
  const events = sortReplyEventsNewestFirst([
    { reply_event_id: 'r1', received_at: '2026-08-25T10:00:00.000Z', classification: 'NOT_INTERESTED' },
    { reply_event_id: 'r2', received_at: '2026-08-28T10:00:00.000Z', classification: 'QUESTION', next_action: 'HUMAN_REPLY', action_status: 'PENDING' },
  ]);
  assert.equal(deriveCurrentState({ outbound: baseOutbound, replyEvents: events, demo: null }).state, 'REPLIED');
  ok('an older NOT_INTERESTED does not override a newer QUESTION');
}

// ---------------------------------------------------------------------------
part('B. needs_human');
// ---------------------------------------------------------------------------

const needsHumanCases = [
  ['REVIEW', { action_status: 'REVIEW', next_action: 'SEND_DEMO' }, true],
  ['FAILED', { action_status: 'FAILED', next_action: 'SEND_DEMO' }, true],
  ['HUMAN_REPLY + PENDING', { action_status: 'PENDING', next_action: 'HUMAN_REPLY' }, true],
  ['BOOK_MEETING + PENDING', { action_status: 'PENDING', next_action: 'BOOK_MEETING' }, true],
  ['MANUAL_REVIEW + PENDING', { action_status: 'PENDING', next_action: 'MANUAL_REVIEW' }, true],
  ['PERMANENT suppression + PENDING', { action_status: 'PENDING', next_action: 'NONE', suppression_type: 'PERMANENT' }, true],
  ['HUMAN_REPLY already COMPLETED', { action_status: 'COMPLETED', next_action: 'HUMAN_REPLY' }, false],
  ['PERMANENT suppression already COMPLETED', { action_status: 'COMPLETED', next_action: 'NONE', suppression_type: 'PERMANENT' }, false],
  ['SEND_DEMO + PENDING is the system\'s job', { action_status: 'PENDING', next_action: 'SEND_DEMO' }, false],
  ['CLOSE + NO_ACTION', { action_status: 'NO_ACTION', next_action: 'CLOSE' }, false],
];

for (const [label, row, expected] of needsHumanCases) {
  assert.equal(deriveNeedsHuman([row]), expected, `needs_human ${label}`);
  ok(`needs_human: ${label} -> ${expected}`);
}

assert.equal(deriveNeedsHuman([]), false);
ok('needs_human: no replies at all -> false');

{
  // ANY relevant row, not just the newest one.
  const events = [
    { received_at: '2026-08-28T10:00:00.000Z', action_status: 'COMPLETED', next_action: 'SEND_DEMO' },
    { received_at: '2026-08-25T10:00:00.000Z', action_status: 'REVIEW', next_action: 'MANUAL_REVIEW' },
  ];
  assert.equal(deriveNeedsHuman(events), true);
  ok('needs_human: an older unresolved row still flags the lead');
}

// ---------------------------------------------------------------------------
part('C. contact type + decision-maker confidence');
// ---------------------------------------------------------------------------

const contactCases = [
  ['owner name matches the contact', { email: 'bradley@stanton.co.uk', contactName: 'Bradley Stanton', ownerName: 'Bradley Stanton' }, 'OWNER_DIRECT'],
  ['owner match survives a middle name', { email: 'b@stanton.co.uk', contactName: 'Bradley J Stanton', ownerName: 'Bradley Stanton' }, 'OWNER_DIRECT'],
  ['a different named human is NAMED_HUMAN', { email: 'sarah@stanton.co.uk', contactName: 'Sarah Webb', ownerName: 'Bradley Stanton' }, 'NAMED_HUMAN'],
  ['generic inbox beats a stored name', { email: 'info@stanton.co.uk', contactName: 'Bradley Stanton', ownerName: 'Bradley Stanton' }, 'GENERIC'],
  ['sales.london@ is still generic', { email: 'sales.london@stanton.co.uk', contactName: '' }, 'GENERIC'],
  ['named human with no owner on file', { email: 'sarah@stanton.co.uk', contactName: 'Sarah Webb' }, 'NAMED_HUMAN'],
  ['RESOLVED_DIRECT with no name still counts as named', { email: 'sw@stanton.co.uk', contactName: '', resolutionStatus: 'RESOLVED_DIRECT' }, 'NAMED_HUMAN'],
  ['no email at all', { email: '', contactName: 'Bradley Stanton' }, 'UNKNOWN'],
  ['unnamed non-generic address, unresolved', { email: 'bx7@stanton.co.uk', contactName: '' }, 'UNKNOWN'],
];

for (const [label, input, expected] of contactCases) {
  assert.equal(deriveContactType(input), expected, `contact type: ${label}`);
  ok(`contact type: ${label} -> ${expected}`);
}

assert.equal(namesLikelySamePerson('B Stanton', 'Bradley Stanton'), false);
ok('contact type: a single initial never promotes to OWNER_DIRECT');

const confidenceCases = [
  [{ contactType: 'OWNER_DIRECT', verificationStatus: 'VALID' }, 'HIGH'],
  [{ contactType: 'OWNER_DIRECT', verificationStatus: 'RISKY' }, 'MEDIUM'],
  [{ contactType: 'NAMED_HUMAN', verificationStatus: 'VALID' }, 'MEDIUM'],
  [{ contactType: 'NAMED_HUMAN', verificationStatus: 'RISKY' }, 'LOW'],
  [{ contactType: 'NAMED_HUMAN', verificationStatus: '' }, 'LOW'],
  [{ contactType: 'GENERIC', verificationStatus: 'VALID' }, 'LOW'],
  [{ contactType: 'UNKNOWN', verificationStatus: 'VALID' }, 'UNKNOWN'],
];
for (const [input, expected] of confidenceCases) {
  assert.equal(deriveDecisionMakerConfidence(input), expected);
  ok(`decision-maker confidence: ${input.contactType}/${input.verificationStatus || '(blank)'} -> ${expected}`);
}

// ---------------------------------------------------------------------------
part('D. latest-event ordering');
// ---------------------------------------------------------------------------

{
  const latest = deriveLatestEvent({
    outbound: { instantly_added_at: '2026-08-20T09:00:00.000Z' },
    replyEvents: [{ received_at: '2026-08-25T09:00:00.000Z', classification: 'QUESTION' }],
    demo: { last_viewed_at: '2026-08-31T09:00:00.000Z', cta_clicked_at: '2026-09-01T09:00:00.000Z' },
  });
  assert.equal(latest.type, 'CTA_CLICKED');
  assert.equal(latest.at, '2026-09-01T09:00:00.000Z');
  ok('latest event picks the newest stored timestamp across all sources');
}

{
  const latest = deriveLatestEvent({
    outbound: { instantly_added_at: '2026-08-20T09:00:00.000Z' },
    replyEvents: [],
    demo: null,
  });
  assert.equal(latest.type, 'ADDED_TO_CAMPAIGN');
  ok('latest event falls back to ADDED_TO_CAMPAIGN');
}

{
  const latest = deriveLatestEvent({ outbound: { instantly_added_at: '' }, replyEvents: [], demo: null });
  assert.deepEqual(latest, { type: null, at: null, summary: '' });
  ok('latest event with no stored timestamps is null, never invented');
}

{
  const latest = deriveLatestEvent({
    outbound: { instantly_added_at: '2026-08-20T09:00:00.000Z' },
    replyEvents: [],
    demo: { last_viewed_at: 'not a date', view_count: '4' },
  });
  assert.equal(latest.type, 'ADDED_TO_CAMPAIGN');
  ok('latest event ignores an unparseable timestamp instead of throwing');
}

{
  const sorted = sortReplyEventsNewestFirst([
    { reply_event_id: 'r_old', received_at: '2026-08-20T09:00:00.000Z' },
    { reply_event_id: 'r_new', received_at: '2026-08-28T09:00:00.000Z' },
    { reply_event_id: 'r_none', processed_at: '2026-08-30T09:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((r) => r.reply_event_id), ['r_none', 'r_new', 'r_old']);
  ok('reply ordering falls back to processed_at when received_at is blank');
}

// ---------------------------------------------------------------------------
part('E. demo engagement');
// ---------------------------------------------------------------------------

const engagementCases = [
  ['meeting booked', { meeting_booked_at: '2026-09-01T09:00:00.000Z', cta_clicked_at: '2026-08-31T09:00:00.000Z' }, 'BOOKED'],
  ['cta clicked', { cta_clicked_at: '2026-08-31T09:00:00.000Z', first_viewed_at: '2026-08-30T09:00:00.000Z' }, 'CTA_CLICKED'],
  ['first viewed', { first_viewed_at: '2026-08-30T09:00:00.000Z' }, 'VIEWED'],
  ['view_count only', { view_count: '2' }, 'VIEWED'],
  ['view_count 0', { view_count: '0' }, 'NONE'],
  ['nothing', {}, 'NONE'],
];
for (const [label, demo, expected] of engagementCases) {
  assert.equal(deriveDemoEngagement(demo), expected, `demo engagement: ${label}`);
  ok(`demo engagement: ${label} -> ${expected}`);
}
assert.equal(deriveDemoEngagement(null), 'NONE');
ok('demo engagement: no DEMOS row -> NONE');

// ---------------------------------------------------------------------------
part('F. multiple journeys for one agency');
// ---------------------------------------------------------------------------

{
  const rows = [
    { outbound_id: 'out_a', instantly_lead_id: '', updated_at: '2026-08-30T09:00:00.000Z' },
    { outbound_id: 'out_b', instantly_lead_id: 'lead_1', instantly_added_at: '2026-08-21T09:00:00.000Z', updated_at: '2026-08-21T09:00:00.000Z' },
    { outbound_id: 'out_c', instantly_lead_id: 'lead_2', instantly_added_at: '2026-08-25T09:00:00.000Z', updated_at: '2026-08-25T09:00:00.000Z' },
  ];
  const { primary, others } = selectPrimaryJourney(rows);
  assert.equal(primary.outbound_id, 'out_c');
  assert.deepEqual(others.map((r) => r.outbound_id), ['out_b', 'out_a']);
  ok('primary journey: a lead id wins, then the latest instantly_added_at');
}

{
  const rows = [
    { outbound_id: 'out_a', instantly_lead_id: '', updated_at: '2026-08-22T09:00:00.000Z' },
    { outbound_id: 'out_b', instantly_lead_id: '', updated_at: '2026-08-29T09:00:00.000Z' },
  ];
  assert.equal(selectPrimaryJourney(rows).primary.outbound_id, 'out_b');
  ok('primary journey: with no lead id, the latest updated_at wins');
}

{
  const rows = [
    { outbound_id: 'out_z', instantly_lead_id: '', updated_at: '' },
    { outbound_id: 'out_a', instantly_lead_id: '', updated_at: '' },
  ];
  assert.equal(selectPrimaryJourney(rows).primary.outbound_id, 'out_a');
  assert.equal(selectPrimaryJourney([...rows].reverse()).primary.outbound_id, 'out_a');
  ok('primary journey: an all-blank tie resolves deterministically on outbound_id');
}

{
  const tables = workbook({
    outbound: [
      { ...baseOutbound, outbound_id: 'out_1', probe_id: 'prb_1', instantly_lead_id: '', instantly_added_at: '', outbound_status: 'READY', updated_at: '2026-08-19T09:00:00.000Z' },
      { ...baseOutbound, outbound_id: 'out_2', probe_id: 'prb_2', instantly_lead_id: 'lead_z', instantly_added_at: '2026-08-24T09:00:00.000Z', updated_at: '2026-08-24T09:00:00.000Z' },
    ],
  });
  const built = buildOperatorLeads(tables, { now: NOW });
  assert.equal(built.leads.length, 1, 'one lead per agency');
  assert.equal(built.leads[0].outbound_id, 'out_2');
  assert.deepEqual(built.leads[0].other_journeys.map((j) => j.outbound_id), ['out_1']);
  assert.equal(built.counts.other_journeys, 1);
  assert.ok(built.warnings.some((w) => w.code === 'multiple_journeys'));
  ok('two OUTBOUND rows for one agency collapse to one lead with the other exposed, never dropped');
}

// ---------------------------------------------------------------------------
part('G. missing optional data');
// ---------------------------------------------------------------------------

{
  // OUTBOUND alone: no AGENCIES, no DEMOS, no PROBES, no INTELLIGENCE row.
  const tables = workbook({ outbound: [{ outbound_id: 'out_1', agency_id: 'ag_1', probe_id: 'prb_1', outbound_status: 'READY' }] });
  const { lead } = firstLead(tables);
  assert.equal(lead.current_state, 'READY');
  assert.equal(lead.needs_human, false);
  assert.equal(lead.priority, null);
  assert.equal(lead.contact.contact_type, 'UNKNOWN');
  assert.equal(lead.contact.decision_maker_confidence, 'UNKNOWN');
  assert.equal(lead.demo.engagement, 'NONE');
  assert.equal(lead.demo.preview_url, '');
  assert.equal(lead.reply.reply_count, 0);
  assert.deepEqual(lead.latest_event, { type: null, at: null, summary: '' });
  assert.equal(lead.probe_summary.grade, '');
  assert.deepEqual(lead.other_journeys, []);
  ok('a bare OUTBOUND row produces a complete lead with blanks, never invented values');
}

{
  const built = buildOperatorLeads({ OUTBOUND: table(OUTBOUND_HEADER, []) }, { now: NOW });
  assert.deepEqual(built.leads, []);
  assert.equal(built.counts.total, 0);
  assert.equal(built.warnings.filter((w) => w.code === 'missing_tab').length, 6);
  ok('missing tabs are reported as warnings and never throw');
}

{
  const tables = workbook({ outbound: [baseOutbound] });
  // A SCHEMA NOTE row must never become a lead.
  tables.OUTBOUND.rows.unshift(OUTBOUND_HEADER.map((c) => (c === 'outbound_id' ? 'SCHEMA NOTE' : '')));
  tables.OUTBOUND.rows.push(OUTBOUND_HEADER.map(() => ''));
  const built = buildOperatorLeads(tables, { now: NOW });
  assert.equal(built.leads.length, 1);
  ok('SCHEMA NOTE and blank-id rows are skipped');
}

// ---------------------------------------------------------------------------
part('H. duplicate IDs');
// ---------------------------------------------------------------------------

{
  const tables = workbook({
    outbound: [baseOutbound],
    agencies: [
      { agency_id: 'ag_1', agency_name: 'Stanton Hockett', outreach_contact_email: 'first@stanton.co.uk', outreach_contact_name: 'First Winner' },
      { agency_id: 'ag_1', agency_name: 'Stanton Hockett (dupe)', outreach_contact_email: 'second@stanton.co.uk', outreach_contact_name: 'Second Loser' },
    ],
    demos: [
      { demo_id: 'dem_1', probe_id: 'prb_1', demo_slug: 'a', grade: 'C' },
      { demo_id: 'dem_2', probe_id: 'prb_1', demo_slug: 'b', grade: 'F' },
    ],
  });
  const { lead, built } = firstLead(tables);
  assert.equal(lead.contact.email, 'first@stanton.co.uk', 'first row wins');
  assert.equal(lead.probe_summary.grade, 'C');
  const codes = built.warnings.filter((w) => w.code === 'duplicate_rows').map((w) => w.detail);
  assert.ok(codes.some((d) => d.includes('AGENCIES.agency_id')));
  assert.ok(codes.some((d) => d.includes('DEMOS.probe_id')));
  ok('duplicate AGENCIES/DEMOS rows resolve first-wins and are reported as warnings');
}

{
  const tables = workbook({
    outbound: [baseOutbound],
    replies: [
      { reply_event_id: 'rep_1', outreach_id: 'out_1', received_at: '2026-08-25T09:00:00.000Z', classification: 'QUESTION', next_action: 'HUMAN_REPLY', action_status: 'PENDING', priority: 'HIGH' },
      { reply_event_id: 'rep_2', outreach_id: 'out_MISSING', received_at: '2026-08-26T09:00:00.000Z', classification: 'QUESTION' },
    ],
  });
  const { lead, built } = firstLead(tables);
  assert.equal(lead.reply.reply_count, 1, 'only the matching reply attaches');
  assert.equal(built.counts.orphan_reply_events, 1);
  assert.ok(built.warnings.some((w) => w.code === 'orphan_reply_events'));
  ok('a reply whose outreach_id matches no OUTBOUND row is counted, not attached to the wrong lead');
}

// ---------------------------------------------------------------------------
part('I. trimmed IDs on both sides of every join');
// ---------------------------------------------------------------------------

{
  const tables = workbook({
    outbound: [{ ...baseOutbound, outbound_id: ' out_1 ', agency_id: ' ag_1', probe_id: 'prb_1  ' }],
    agencies: [{ agency_id: 'ag_1 ', agency_name: 'Stanton Hockett', outreach_contact_email: 'bradley@stanton.co.uk', outreach_contact_name: 'Bradley Stanton', owner_md: 'Bradley Stanton', email_verification_status: 'VALID' }],
    demos: [{ demo_id: 'dem_1', probe_id: ' prb_1', demo_slug: 'stanton-high-street', cta_clicked_at: '2026-08-31T09:00:00.000Z' }],
    intelligence: [{ intelligence_id: 'int_1', probe_id: 'prb_1 ', grade: 'F', grade_reason: 'No human response' }],
    probes: [{ probe_id: '  prb_1', probe_reference: 'PR-001', property_street: '10 High Street' }],
    personalisation: [{ probe_id: 'prb_1', email_observation: 'No reply in four days.' }],
    replies: [{ reply_event_id: 'rep_1', outreach_id: 'out_1 ', received_at: '2026-08-25T09:00:00.000Z', classification: 'QUESTION', next_action: 'HUMAN_REPLY', action_status: 'PENDING', priority: 'HIGH' }],
  });
  const { lead } = firstLead(tables);
  assert.equal(lead.outbound_id, 'out_1');
  assert.equal(lead.agency_id, 'ag_1');
  assert.equal(lead.probe_id, 'prb_1');
  assert.equal(lead.contact.contact_type, 'OWNER_DIRECT');
  assert.equal(lead.contact.decision_maker_confidence, 'HIGH');
  assert.equal(lead.probe_summary.grade, 'F');
  assert.equal(lead.probe_summary.probe_reference, 'PR-001');
  assert.equal(lead.reply.reply_count, 1, 'the reply joined despite the trailing space');
  assert.equal(lead.demo.engagement, 'CTA_CLICKED');
  assert.equal(lead.current_state, 'DEMO_ENGAGED');
  ok('every join trims whitespace on both sides');
}

// ---------------------------------------------------------------------------
part('J. demo links are always preview links');
// ---------------------------------------------------------------------------

{
  const { lead } = firstLead(workbook({ outbound: [baseOutbound] }));
  assert.equal(lead.demo.url, 'https://demo.getnovus.co.uk/stanton-high-street');
  assert.equal(lead.demo.preview_url, 'https://demo.getnovus.co.uk/stanton-high-street?preview=1');
  ok('preview_url carries ?preview=1 so the operator never inflates view_count');
}

{
  const tables = workbook({ outbound: [{ ...baseOutbound, demo_url: 'https://demo.getnovus.co.uk/x?utm=1' }] });
  assert.equal(firstLead(tables).lead.demo.preview_url, 'https://demo.getnovus.co.uk/x?utm=1&preview=1');
  ok('preview flag appends correctly to a URL that already has a query string');
}

// ---------------------------------------------------------------------------
part('K. priority, counts and ordering');
// ---------------------------------------------------------------------------

assert.equal(derivePriority([{ priority: 'NORMAL' }, { priority: 'CRITICAL' }, { priority: 'LOW' }]), 'CRITICAL');
ok('priority takes the most severe value across the journey');
assert.equal(derivePriority([{ priority: '' }, { priority: 'nonsense' }]), null);
ok('priority is null rather than guessed when nothing valid is stored');

{
  const tables = workbook({
    outbound: [
      { ...baseOutbound, outbound_id: 'out_calm', agency_id: 'ag_calm', probe_id: 'prb_calm', clean_agency_name: 'Calm Ltd' },
      { ...baseOutbound, outbound_id: 'out_hot', agency_id: 'ag_hot', probe_id: 'prb_hot', clean_agency_name: 'Hot Ltd' },
      { ...baseOutbound, outbound_id: 'out_crit', agency_id: 'ag_crit', probe_id: 'prb_crit', clean_agency_name: 'Critical Ltd' },
    ],
    replies: [
      { reply_event_id: 'r_hot', outreach_id: 'out_hot', received_at: '2026-08-26T09:00:00.000Z', classification: 'QUESTION', next_action: 'HUMAN_REPLY', action_status: 'PENDING', priority: 'HIGH' },
      { reply_event_id: 'r_crit', outreach_id: 'out_crit', received_at: '2026-08-25T09:00:00.000Z', classification: 'POSITIVE_MEETING', next_action: 'BOOK_MEETING', action_status: 'PENDING', priority: 'CRITICAL' },
    ],
  });
  const built = buildOperatorLeads(tables, { now: NOW });
  assert.deepEqual(built.leads.map((l) => l.outbound_id), ['out_crit', 'out_hot', 'out_calm']);
  assert.equal(built.counts.total, 3);
  assert.equal(built.counts.needs_attention, 2);
  assert.equal(built.counts.replied, 2);
  assert.equal(built.counts.sequence_running, 3);
  assert.equal(built.counts.meetings, 0);
  assert.equal(built.counts.by_state.SEQUENCE_RUNNING, 1);
  assert.equal(built.counts.by_state.REPLIED, 2);
  ok('leads sort needs_human first then CRITICAL before HIGH, and counts agree');
}

{
  const tables = workbook({
    outbound: [baseOutbound],
    demos: [{ demo_id: 'dem_1', probe_id: 'prb_1', demo_slug: 'x', meeting_booked_at: '2026-09-01T09:00:00.000Z' }],
  });
  const built = buildOperatorLeads(tables, { now: NOW });
  assert.equal(built.counts.meetings, 1);
  assert.equal(built.counts.by_state.MEETING_BOOKED, 1);
  assert.equal(built.counts.demo_engaged, 1);
  ok('a booked meeting counts as a meeting and as demo engagement');
}

// ---------------------------------------------------------------------------
part('L. determinism and input immutability');
// ---------------------------------------------------------------------------

{
  const tables = workbook({
    outbound: [
      { ...baseOutbound, outbound_id: 'out_1' },
      { ...baseOutbound, outbound_id: 'out_2', agency_id: 'ag_2', probe_id: 'prb_2', clean_agency_name: 'Beta Ltd' },
    ],
    replies: [{ reply_event_id: 'rep_1', outreach_id: 'out_1', received_at: '2026-08-25T09:00:00.000Z', classification: 'QUESTION', next_action: 'HUMAN_REPLY', action_status: 'PENDING', priority: 'HIGH' }],
  });
  const snapshot = JSON.stringify(tables);
  const a = buildOperatorLeads(tables, { now: NOW });
  const b = buildOperatorLeads(tables, { now: NOW });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(tables), snapshot, 'input tables were mutated');
  ok('the aggregator is deterministic and does not mutate its input');
}

// ---------------------------------------------------------------------------
part('M. the API operation is read-only');
// ---------------------------------------------------------------------------

{
  process.env.NOVUS_BASIC_AUTH_USER = 'test-user';
  process.env.NOVUS_BASIC_AUTH_PASS = 'test-pass';

  const store = {
    OUTBOUND: [OUTBOUND_HEADER.slice(), OUTBOUND_HEADER.map((c) => baseOutbound[c] ?? '')],
    REPLY_EVENTS: [REPLY_EVENTS_HEADER.slice()],
    DEMOS: [DEMOS_HEADER.slice()],
    AGENCIES: [AGENCIES_HEADER.slice()],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice()],
    PERSONALISATION: [PERSONALISATION_HEADER.slice()],
    PROBES: [PROBES_HEADER.slice()],
  };
  const calls = { get: 0, append: 0, update: 0, batchUpdate: 0 };
  const repo = {
    async getTable(tab) {
      calls.get += 1;
      const values = store[tab] || [];
      return { header: values[0] || [], rows: values.slice(1), allValues: values };
    },
    async getRecords() { throw new Error('getRecords must not be reached by operator-leads'); },
    async findById() { throw new Error('findById must not be reached by operator-leads'); },
    async appendRecord() { calls.append += 1; throw new Error('WRITE ATTEMPTED'); },
    async appendRowsBatch() { calls.append += 1; throw new Error('WRITE ATTEMPTED'); },
    async updateCell() { calls.update += 1; throw new Error('WRITE ATTEMPTED'); },
    async updateById() { calls.update += 1; throw new Error('WRITE ATTEMPTED'); },
    async writeRowsBatch() { calls.batchUpdate += 1; throw new Error('WRITE ATTEMPTED'); },
    async writeCellsBatch() { calls.batchUpdate += 1; throw new Error('WRITE ATTEMPTED'); },
  };
  __setRepoForTests(repo);

  function fakeRes() {
    const res = { statusCode: 0, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.end = () => res;
    return res;
  }
  const authHeader = `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`;

  // Unauthenticated -> 401, and no tab is read.
  const unauth = fakeRes();
  await personalisationHandler({ method: 'GET', query: { novus_operation: 'operator-leads' }, headers: {} }, unauth);
  assert.equal(unauth.statusCode, 401);
  assert.equal(calls.get, 0);
  ok('operator-leads requires Basic Auth before any Sheets read');

  const res1 = fakeRes();
  await personalisationHandler(
    { method: 'GET', query: { novus_operation: 'operator-leads', refresh: '1' }, headers: { authorization: authHeader } },
    res1,
  );
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.success, true);
  assert.equal(res1.body.leads.length, 1);
  assert.equal(res1.body.cached, false);
  assert.equal(calls.get, 7, 'exactly the seven operator tabs are read');
  assert.deepEqual({ append: calls.append, update: calls.update, batchUpdate: calls.batchUpdate }, { append: 0, update: 0, batchUpdate: 0 });
  assert.equal(res1.headers['cache-control'], 'private, no-store, max-age=0');
  ok('operator-leads reads seven tabs, writes nothing, and is never proxy-cacheable');

  // Second call inside the TTL is served from the in-process cache.
  const res2 = fakeRes();
  await personalisationHandler(
    { method: 'GET', query: { novus_operation: 'operator-leads' }, headers: { authorization: authHeader } },
    res2,
  );
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.cached, true);
  assert.ok(res2.body.cache_age_ms >= 0);
  assert.equal(calls.get, 7, 'the cached response performed no further reads');
  ok('a second call inside the TTL is served from the in-process cache with no extra reads');

  // refresh=1 bypasses the cache.
  const res3 = fakeRes();
  await personalisationHandler(
    { method: 'GET', query: { novus_operation: 'operator-leads', refresh: '1' }, headers: { authorization: authHeader } },
    res3,
  );
  assert.equal(res3.body.cached, false);
  assert.equal(calls.get, 14);
  ok('refresh=1 bypasses the cache and re-reads');

  // POST must never reach the operator branch.
  const res4 = fakeRes();
  await personalisationHandler(
    { method: 'POST', query: { novus_operation: 'operator-leads' }, headers: { authorization: authHeader }, body: {} },
    res4,
  );
  assert.equal(res4.statusCode, 405);
  assert.deepEqual({ append: calls.append, update: calls.update, batchUpdate: calls.batchUpdate }, { append: 0, update: 0, batchUpdate: 0 });
  ok('POST to operator-leads is rejected with 405 and writes nothing');

  __setRepoForTests(null);
}

console.log(`\nNOVUS operator-leads self-test passed (${passed} focused assertions).`);
