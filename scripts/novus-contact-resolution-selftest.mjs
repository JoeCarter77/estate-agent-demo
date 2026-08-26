// scripts/novus-contact-resolution-selftest.mjs — hermetic contact-resolution
// tests (no network, no creds, no NeverBounce/Hunter/AI calls).
//
// Exercises the REAL code paths — lib/contact-resolution.mjs and the
// /api/novus/contacts/resolve handler inside api/novus/personalisation.js —
// against an in-memory fake of the Google Sheets values API in the live
// workbook's shape (row 1 = header, row 2 = SCHEMA NOTE, row 3+ = data).
//
// NeverBounce, Hunter and owner research are all injected as fakes, so every
// assertion here is about the waterfall/persistence logic, never about a
// provider. The counters those fakes keep are load-bearing: several tests
// assert on how many times a provider WOULD have been called.
//
// Run:  npm run novus:contact-resolution-selftest

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRepo } from '../lib/sheets.mjs';
import {
  resolveAgencyContact,
  listResolutionBacklog,
  buildCandidates,
  buildVerificationCache,
  isGenericEmail,
  isAutomatedSender,
  nameMatchesLocalPart,
  verdictForCandidate,
  HUNTER_HIGH_CONFIDENCE_SCORE,
  PRIORITY,
} from '../lib/contact-resolution.mjs';
import { normalizeNeverBounceResult, HARD_FAIL_STATUSES, INCONCLUSIVE_STATUSES } from '../lib/neverbounce.mjs';

const AGENCIES_HEADER = [
  'agency_id','agency_name','website','domain','location','branch_count','main_phone',
  'known_phone_numbers','primary_contact_name','primary_contact_email','other_known_emails',
  'owner_md','independent_franchise_corporate','sales_led_lettings_only','years_trading',
  'incorporation_date','live_listing_count','crm_name','crm_evidence','qualification_segment',
  'current_pipeline_status','suppression_status','suppression_reason','probe_sent',
  'outreach_contact_name','outreach_contact_email','email_verification_status',
  'contact_resolution_status','notes','created_at','updated_at',
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
const CONTACTS_HEADER = [
  'contact_id','agency_id','contact_name','contact_role','email','email_source','contact_type',
  'verification_status','verified_at','is_selected_for_outreach','notes','created_at','updated_at',
];

// ── In-memory fake of the Google Sheets values API ──────────────────────────
function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', 'One row per meaningful communication.']],
    CONTACTS: [CONTACTS_HEADER.slice(), ['SCHEMA NOTE', 'One row per agency + email address.']],
  };
  const tabOf = (range) => String(range).split('!')[0];
  const startRowOf = (range) => {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const colOf = (range) => {
    const m = String(range).match(/!([A-Z]+)\d+/);
    return m ? m[1] : null;
  };
  const colIndex = (letters) => letters.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

  const valuesApi = {
    async get(range) {
      return (store[tabOf(range)] || []).map((r) => r.slice());
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
      const col = colIndex(colOf(range));
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => {
        const rowIdx = start - 1 + i;
        if (col === 0 && r.length > 1) {
          store[tab][rowIdx] = r.slice(); // full-row write (updateById)
        } else {
          const existing = store[tab][rowIdx] || [];
          while (existing.length <= col) existing.push('');
          existing[col] = r[0];           // single-cell write (updateCell)
          store[tab][rowIdx] = existing;
        }
      });
      return { updatedRows: rows.length };
    },
  };
  return { store, valuesApi };
}

function rowsAsObjects(store, tab, header) {
  return store[tab].slice(1)
    .filter((r) => r[0] && r[0] !== 'SCHEMA NOTE')
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}

function seedAgency(store, fields) {
  store.AGENCIES.push(AGENCIES_HEADER.map((key) => fields[key] ?? ''));
}
function seedCommunication(store, fields) {
  store.COMMUNICATIONS.push(COMMUNICATIONS_HEADER.map((key) => fields[key] ?? ''));
}
function seedContact(store, fields) {
  store.CONTACTS.push(CONTACTS_HEADER.map((key) => fields[key] ?? ''));
}

// ── Injectable provider fakes ───────────────────────────────────────────────
function makeVerifier(resultsByEmail, { defaultStatus = 'INVALID' } = {}) {
  const calls = [];
  const impl = async (email) => {
    calls.push(email);
    const configured = resultsByEmail[email];
    if (configured instanceof Error) throw configured;
    return { verification_status: configured || defaultStatus, raw_result: { result: configured || defaultStatus } };
  };
  impl.calls = calls;
  return impl;
}
function makeHunter(result) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  impl.calls = calls;
  return impl;
}
const noResearch = async () => ({ found: false });
const clock = () => '2026-08-26T12:00:00.000Z';

function baseOptions(overrides = {}) {
  return {
    verifyEmailImpl: makeVerifier({}),
    findEmailImpl: makeHunter(null),
    researchOwnerImpl: noResearch,
    hunterConfigured: () => true,
    now: clock,
    ...overrides,
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('NOVUS contact resolution self-test\n');

// ── Unit-level classification ───────────────────────────────────────────────
await test('generic and automated address classification', () => {
  for (const e of ['info@a.co.uk', 'hello@a.co.uk', 'sales@a.co.uk', 'office@a.co.uk',
    'admin@a.co.uk', 'enquiries@a.co.uk', 'contact@a.co.uk', 'sales.london@a.co.uk']) {
    assert.equal(isGenericEmail(e), true, e);
  }
  assert.equal(isGenericEmail('james.hale@a.co.uk'), false);

  for (const e of ['noreply@a.co.uk', 'no-reply@a.co.uk', 'donotreply@a.co.uk',
    'notifications@a.co.uk', 'mailer-daemon@a.co.uk', 'postmaster@a.co.uk']) {
    assert.equal(isAutomatedSender(e), true, e);
  }
  assert.equal(isAutomatedSender('james.hale@a.co.uk'), false);
});

await test('owner name matching is conservative', () => {
  assert.equal(nameMatchesLocalPart('James Hale', 'james.hale'), true);
  assert.equal(nameMatchesLocalPart('James Hale', 'jhale'), true);
  assert.equal(nameMatchesLocalPart('James Hale', 'james'), true);
  assert.equal(nameMatchesLocalPart('James Hale', 'halej'), true);
  // Not the owner: substring lookalikes and unrelated humans must not be
  // promoted into the top tier.
  assert.equal(nameMatchesLocalPart('James Hale', 'jameson'), false);
  assert.equal(nameMatchesLocalPart('James Hale', 'sarah'), false);
  assert.equal(nameMatchesLocalPart('James Hale', 'info'), false);
});

await test('a populated primary email is not assumed to be the owner', () => {
  const candidates = buildCandidates({
    agency: {
      agency_id: 'ag_1', domain: 'a.co.uk',
      primary_contact_name: 'James Hale', primary_contact_email: 'sarah@a.co.uk',
    },
    communications: [],
    owner: { person_name: 'James Hale', rank: 1, role_title: 'Owner' },
  });
  const sarah = candidates.find((c) => c.email === 'sarah@a.co.uk');
  assert.notEqual(sarah.priority, PRIORITY.OWNER_DIRECT);
  assert.equal(sarah.name, '');
});

// ── Flow 1: valid owner direct email ────────────────────────────────────────
await test('valid owner direct email wins outright', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_1', agency_name: 'Hale & Co', domain: 'haleandco.co.uk', probe_sent: 'YES',
    owner_md: 'James Hale',
    primary_contact_email: 'james.hale@haleandco.co.uk',
    other_known_emails: 'info@haleandco.co.uk',
  });
  const verifier = makeVerifier({ 'james.hale@haleandco.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_1', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 'james.hale@haleandco.co.uk');
  assert.equal(result.selected_contact.contact_name, 'James Hale');
  assert.equal(result.owner_md.value, 'James Hale');
  assert.equal(result.hunter.used, false);
  // The generic inbox was a candidate but must never have been verified.
  assert.deepEqual(verifier.calls, ['james.hale@haleandco.co.uk']);
  assert.ok(result.neverbounce.not_verified_after_winner.includes('info@haleandco.co.uk'));

  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.outreach_contact_name, 'James Hale');
  assert.equal(agency.outreach_contact_email, 'james.hale@haleandco.co.uk');
  assert.equal(agency.email_verification_status, 'VALID');
  assert.equal(agency.contact_resolution_status, 'RESOLVED_DIRECT');

  const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  assert.equal(contacts.length, 2);
  const selected = contacts.filter((c) => c.is_selected_for_outreach === 'TRUE');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].email, 'james.hale@haleandco.co.uk');
  assert.equal(selected[0].verification_status, 'VALID');
  assert.equal(selected[0].verified_at, clock());
});

// ── Flow 2: known owner + only generic email -> Hunter -> valid ─────────────
await test('known owner with only a generic email: Hunter finds the direct address', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_2', agency_name: 'Bell Estates', domain: 'bellestates.co.uk', probe_sent: 'YES',
    owner_md: 'Marie Bell', primary_contact_email: 'info@bellestates.co.uk',
  });
  const hunter = makeHunter({ email: 'marie.bell@bellestates.co.uk', score: 94, position: 'Managing Director' });
  const verifier = makeVerifier({ 'marie.bell@bellestates.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_2', baseOptions({
    verifyEmailImpl: verifier, findEmailImpl: hunter,
  }));

  assert.equal(hunter.calls.length, 1);
  assert.deepEqual(hunter.calls[0], { name: 'Marie Bell', domain: 'bellestates.co.uk' });
  assert.equal(result.hunter.used, true);
  assert.equal(result.hunter.email, 'marie.bell@bellestates.co.uk');
  // Hunter FOUND it; NeverBounce still decided it.
  assert.ok(verifier.calls.includes('marie.bell@bellestates.co.uk'));
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 'marie.bell@bellestates.co.uk');
  assert.equal(result.selected_contact.email_source, 'HUNTER');
  // The Hunter result outranks the generic inbox, so the inbox is never checked.
  assert.deepEqual(verifier.calls, ['marie.bell@bellestates.co.uk']);
});

await test('Hunter is skipped when we already hold a direct address for the owner', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_2b', agency_name: 'Bell Estates', domain: 'bellestates.co.uk',
    owner_md: 'Marie Bell', primary_contact_email: 'mbell@bellestates.co.uk',
  });
  const hunter = makeHunter({ email: 'marie.bell@bellestates.co.uk' });
  const result = await resolveAgencyContact(repo, 'ag_2b', baseOptions({
    verifyEmailImpl: makeVerifier({ 'mbell@bellestates.co.uk': 'VALID' }), findEmailImpl: hunter,
  }));
  assert.equal(hunter.calls.length, 0);
  assert.equal(result.hunter.attempted, false);
  assert.equal(result.selected_contact.email, 'mbell@bellestates.co.uk');
});

// ── Flow 3: direct invalid -> human communication contact valid ─────────────
await test('invalid direct email falls through to a human COMMUNICATIONS contact', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_3', agency_name: 'Croft Property', domain: 'croftproperty.co.uk', probe_sent: 'YES',
    owner_md: 'Alan Croft', primary_contact_email: 'alan.croft@croftproperty.co.uk',
    other_known_emails: 'info@croftproperty.co.uk',
  });
  seedCommunication(store, {
    communication_id: 'com_1', agency_id: 'ag_3', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'noreply@croftproperty.co.uk', automated_or_human: 'automated',
    occurred_at: '2026-08-01T09:00:00.000Z',
  });
  seedCommunication(store, {
    communication_id: 'com_2', agency_id: 'ag_3', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'nadia.khan@croftproperty.co.uk', display_name: 'Nadia Khan',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const verifier = makeVerifier({
    'alan.croft@croftproperty.co.uk': 'INVALID',
    'nadia.khan@croftproperty.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_3', baseOptions({ verifyEmailImpl: verifier }));

  // The automated sender never became a candidate at all.
  assert.ok(!result.candidates_considered.some((c) => c.email.startsWith('noreply@')));
  assert.deepEqual(verifier.calls, ['alan.croft@croftproperty.co.uk', 'nadia.khan@croftproperty.co.uk']);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 'nadia.khan@croftproperty.co.uk');
  assert.equal(result.selected_contact.contact_name, 'Nadia Khan');
  assert.equal(result.selected_contact.email_source, 'COMMUNICATIONS');
});

// ── Flow 4: generic fallback ────────────────────────────────────────────────
await test('generic inbox is used only after every direct candidate fails', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_4', agency_name: 'Dune Homes', domain: 'dunehomes.co.uk', probe_sent: 'YES',
    owner_md: 'Peter Dune', primary_contact_email: 'peter.dune@dunehomes.co.uk',
    other_known_emails: 'enquiries@dunehomes.co.uk',
  });
  const verifier = makeVerifier({
    'peter.dune@dunehomes.co.uk': 'INVALID',
    'enquiries@dunehomes.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_4', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
  assert.equal(result.selected_contact.email, 'enquiries@dunehomes.co.uk');
  assert.equal(result.selected_contact.contact_type, 'GENERIC');
  // A generic winner carries no person name back to AGENCIES.
  assert.equal(result.selected_contact.contact_name, '');
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.outreach_contact_name, '');
  assert.equal(agency.outreach_contact_email, 'enquiries@dunehomes.co.uk');
  assert.equal(agency.contact_resolution_status, 'RESOLVED_GENERIC');
});

// ── Flow 5: UNKNOWN / RISKY move on ─────────────────────────────────────────
await test('UNKNOWN and RISKY results move to the next candidate', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_5', agency_name: 'Ridge & Vale', domain: 'ridgevale.co.uk', probe_sent: 'YES',
    owner_md: 'Tom Ridge', primary_contact_email: 'tom.ridge@ridgevale.co.uk',
    other_known_emails: 't.ridge@ridgevale.co.uk, office@ridgevale.co.uk',
  });
  const verifier = makeVerifier({
    'tom.ridge@ridgevale.co.uk': 'UNKNOWN',
    't.ridge@ridgevale.co.uk': 'RISKY',
    'office@ridgevale.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_5', baseOptions({ verifyEmailImpl: verifier }));

  assert.deepEqual(verifier.calls, [
    'tom.ridge@ridgevale.co.uk', 't.ridge@ridgevale.co.uk', 'office@ridgevale.co.uk',
  ]);
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
  const statuses = Object.fromEntries(result.candidates_verified.map((v) => [v.email, v.verification_status]));
  assert.equal(statuses['tom.ridge@ridgevale.co.uk'], 'UNKNOWN');
  assert.equal(statuses['t.ridge@ridgevale.co.uk'], 'RISKY');
});

// ── Flow 6: everything fails ────────────────────────────────────────────────
await test('all candidates failing gives NO_VALID_EMAIL and no selected contact', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_6', agency_name: 'Falls Estates', domain: 'fallsestates.co.uk', probe_sent: 'YES',
    owner_md: 'Ruth Falls', primary_contact_email: 'ruth.falls@fallsestates.co.uk',
    other_known_emails: 'info@fallsestates.co.uk',
  });
  const verifier = makeVerifier({}, { defaultStatus: 'INVALID' });
  const result = await resolveAgencyContact(repo, 'ag_6', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(result.contact_resolution_status, 'NO_VALID_EMAIL');
  assert.equal(result.selected_contact, null);
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.contact_resolution_status, 'NO_VALID_EMAIL');
  assert.equal(agency.outreach_contact_email, '');
  assert.equal(agency.email_verification_status, '');
  const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((c) => c.is_selected_for_outreach === 'FALSE'));
});

// ── Flow 7: cached verification avoids a repeat NeverBounce call ────────────
await test('a recent stored verification is reused instead of calling NeverBounce', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_7', agency_name: 'Marsh Homes', domain: 'marshhomes.co.uk', probe_sent: 'YES',
    owner_md: 'Ella Marsh', primary_contact_email: 'ella.marsh@marshhomes.co.uk',
  });
  seedContact(store, {
    contact_id: 'cnt_seed', agency_id: 'ag_7', email: 'ella.marsh@marshhomes.co.uk',
    contact_name: 'Ella Marsh', email_source: 'AGENCIES.primary_contact_email', contact_type: 'DIRECT',
    verification_status: 'VALID', verified_at: '2026-08-20T09:00:00.000Z',
    is_selected_for_outreach: 'FALSE', created_at: '2026-08-20T09:00:00.000Z',
  });
  const verifier = makeVerifier({ 'ella.marsh@marshhomes.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_7', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(verifier.calls.length, 0, 'NeverBounce must not be called again for a fresh result');
  assert.equal(result.neverbounce.calls_made, 0);
  assert.equal(result.neverbounce.cached_reuses, 1);
  assert.equal(result.candidates_verified[0].cached, true);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');

  // ...and a stale result is NOT reused.
  const stale = buildVerificationCache(
    [{ obj: { email: 'old@x.co.uk', verification_status: 'VALID', verified_at: '2020-01-01T00:00:00.000Z' } }],
    { now: Date.parse(clock()) },
  );
  assert.equal(stale.size, 0);
});

// ── Flow 8: rerun is idempotent ─────────────────────────────────────────────
await test('rerunning an agency does not duplicate CONTACTS rows', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_8', agency_name: 'Quay Residential', domain: 'quayres.co.uk', probe_sent: 'YES',
    owner_md: 'Sam Quay', primary_contact_email: 'sam.quay@quayres.co.uk',
    other_known_emails: 'info@quayres.co.uk',
  });
  const options = () => baseOptions({
    verifyEmailImpl: makeVerifier({ 'sam.quay@quayres.co.uk': 'VALID' }),
  });
  await resolveAgencyContact(repo, 'ag_8', options());
  const first = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  const firstIds = first.map((c) => c.contact_id).sort();

  await resolveAgencyContact(repo, 'ag_8', options());
  await resolveAgencyContact(repo, 'ag_8', options());
  const after = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);

  assert.equal(after.length, first.length, 'rerun must not append duplicate rows');
  assert.deepEqual(after.map((c) => c.contact_id).sort(), firstIds, 'contact_ids must be stable across reruns');
  assert.equal(after.filter((c) => c.is_selected_for_outreach === 'TRUE').length, 1);
});

await test('a previously selected contact is deselected when the winner changes', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_8b', agency_name: 'Old Pick', domain: 'oldpick.co.uk',
    owner_md: 'Ivy Pick', primary_contact_email: 'ivy.pick@oldpick.co.uk',
  });
  seedContact(store, {
    contact_id: 'cnt_old', agency_id: 'ag_8b', email: 'someone.else@oldpick.co.uk',
    contact_type: 'DIRECT', is_selected_for_outreach: 'TRUE', created_at: '2026-08-01T00:00:00.000Z',
  });
  await resolveAgencyContact(repo, 'ag_8b', baseOptions({
    verifyEmailImpl: makeVerifier({ 'ivy.pick@oldpick.co.uk': 'VALID' }),
  }));
  const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  const selected = contacts.filter((c) => c.is_selected_for_outreach === 'TRUE');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].email, 'ivy.pick@oldpick.co.uk');
  assert.equal(contacts.find((c) => c.contact_id === 'cnt_old').is_selected_for_outreach, 'FALSE');
});

// ── Flow 9: Hunter failure falls back cleanly ───────────────────────────────
await test('a Hunter failure never fails the agency', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_9', agency_name: 'Vale Lettings', domain: 'valelettings.co.uk', probe_sent: 'YES',
    owner_md: 'Greg Vale', primary_contact_email: 'info@valelettings.co.uk',
  });
  const hunter = makeHunter(new Error('Hunter 503'));
  const result = await resolveAgencyContact(repo, 'ag_9', baseOptions({
    verifyEmailImpl: makeVerifier({ 'info@valelettings.co.uk': 'VALID' }), findEmailImpl: hunter,
  }));
  assert.equal(hunter.calls.length, 1);
  assert.equal(result.hunter.used, false);
  assert.match(result.hunter.error, /Hunter 503/);
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
  assert.equal(result.selected_contact.email, 'info@valelettings.co.uk');
});

await test('Hunter returning no match falls through to the generic inbox', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_9b', agency_name: 'Vale Lettings', domain: 'valelettings.co.uk',
    owner_md: 'Greg Vale', primary_contact_email: 'info@valelettings.co.uk',
  });
  const result = await resolveAgencyContact(repo, 'ag_9b', baseOptions({
    verifyEmailImpl: makeVerifier({ 'info@valelettings.co.uk': 'VALID' }),
    findEmailImpl: makeHunter(null),
  }));
  assert.equal(result.hunter.used, false);
  assert.match(result.hunter.reason, /no address/i);
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
});

// ── Flow 10: no owner known ─────────────────────────────────────────────────
await test('blank owner_md still resolves from existing contacts', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_10', agency_name: 'Anon Estates', domain: 'anonestates.co.uk', probe_sent: 'YES',
    owner_md: '', primary_contact_email: 'info@anonestates.co.uk',
  });
  seedCommunication(store, {
    communication_id: 'com_10', agency_id: 'ag_10', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'lucy.reed@anonestates.co.uk', display_name: 'Lucy Reed',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const hunter = makeHunter({ email: 'never@used.co.uk' });
  const result = await resolveAgencyContact(repo, 'ag_10', baseOptions({
    verifyEmailImpl: makeVerifier({ 'lucy.reed@anonestates.co.uk': 'VALID' }),
    findEmailImpl: hunter,
    researchOwnerImpl: noResearch,
  }));

  // Research was inconclusive: no person invented, no Hunter lookup attempted.
  assert.equal(result.owner_md.value, '');
  assert.equal(hunter.calls.length, 0);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 'lucy.reed@anonestates.co.uk');
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.owner_md, '', 'inconclusive research must never write an owner');
});

await test('blank owner_md with nothing usable is NEEDS_RESEARCH', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_10b', agency_name: 'Empty Estates', domain: 'emptyestates.co.uk', probe_sent: 'YES',
  });
  const result = await resolveAgencyContact(repo, 'ag_10b', baseOptions({ researchOwnerImpl: noResearch }));
  assert.equal(result.candidates_considered.length, 0);
  assert.equal(result.contact_resolution_status, 'NEEDS_RESEARCH');
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.contact_resolution_status, 'NEEDS_RESEARCH');
});

// ── Flow 11: research finds an owner, then Hunter finds their address ───────
await test('researched owner is saved with evidence and feeds the Hunter step', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_11', agency_name: 'Kestrel & Co', domain: 'kestrelco.co.uk', probe_sent: 'YES',
    owner_md: '', primary_contact_email: 'info@kestrelco.co.uk', notes: 'Existing note.',
  });
  const research = async () => ({
    found: true, person_name: 'Helen Kestrel', role: 'MANAGING_DIRECTOR', role_title: 'Managing Director',
    evidence: 'Named as Managing Director on the agency About page and at Companies House.',
    source_url: 'https://kestrelco.co.uk/about', source_type: 'AGENCY_WEBSITE', confidence: 'HIGH',
  });
  const hunter = makeHunter({ email: 'helen.kestrel@kestrelco.co.uk', score: 88, position: 'Managing Director' });
  const result = await resolveAgencyContact(repo, 'ag_11', baseOptions({
    verifyEmailImpl: makeVerifier({ 'helen.kestrel@kestrelco.co.uk': 'VALID' }),
    findEmailImpl: hunter,
    researchOwnerImpl: research,
  }));

  assert.equal(result.owner_md.value, 'Helen Kestrel');
  assert.equal(result.owner_md.was_blank, true);
  assert.equal(result.owner_md.research.source_type, 'AGENCY_WEBSITE');
  assert.deepEqual(hunter.calls[0], { name: 'Helen Kestrel', domain: 'kestrelco.co.uk' });
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');

  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.owner_md, 'Helen Kestrel');
  assert.match(agency.notes, /Existing note\./);
  assert.match(agency.notes, /Helen Kestrel/);
  assert.match(agency.notes, /kestrelco\.co\.uk\/about/);
});

// ── NeverBounce verdict vocabulary ──────────────────────────────────────────
await test('NeverBounce results map to five distinct statuses', () => {
  assert.equal(normalizeNeverBounceResult('valid'), 'VALID');
  assert.equal(normalizeNeverBounceResult('invalid'), 'INVALID');
  // DISPOSABLE is its own verdict now, no longer flattened into INVALID.
  assert.equal(normalizeNeverBounceResult('disposable'), 'DISPOSABLE');
  assert.equal(normalizeNeverBounceResult('unknown'), 'UNKNOWN');
  // Accept-all/catchall in every spelling is RISKY — never a hard failure.
  for (const spelling of ['catchall', 'catch_all', 'catch-all', 'accept_all', 'accept-all', 'accepts_all']) {
    assert.equal(normalizeNeverBounceResult(spelling), 'RISKY', spelling);
  }
  assert.ok(!HARD_FAIL_STATUSES.has('RISKY'), 'accept-all must never be a hard failure');
  assert.ok(!HARD_FAIL_STATUSES.has('UNKNOWN'));
  assert.deepEqual([...HARD_FAIL_STATUSES].sort(), ['DISPOSABLE', 'INVALID']);
  assert.deepEqual([...INCONCLUSIVE_STATUSES].sort(), ['RISKY', 'UNKNOWN']);
});

await test('verdictForCandidate: caution rule softens only inconclusive verdicts', () => {
  const strong = { high_confidence_owner: true, hunter_score: 95 };
  const ordinary = { high_confidence_owner: false, hunter_score: 60 };
  assert.equal(verdictForCandidate(strong, 'VALID'), 'SELECT');
  assert.equal(verdictForCandidate(strong, 'UNKNOWN'), 'SELECT');
  assert.equal(verdictForCandidate(strong, 'RISKY'), 'SELECT');
  assert.equal(verdictForCandidate(strong, 'INVALID'), 'REJECT');
  assert.equal(verdictForCandidate(strong, 'DISPOSABLE'), 'REJECT');
  assert.equal(verdictForCandidate(ordinary, 'VALID'), 'SELECT');
  assert.equal(verdictForCandidate(ordinary, 'UNKNOWN'), 'CONTINUE');
  assert.equal(verdictForCandidate(ordinary, 'RISKY'), 'CONTINUE');
  assert.equal(verdictForCandidate(ordinary, 'INVALID'), 'REJECT');
});

// ── High-confidence owner/MD caution rule, end to end ───────────────────────
//
// The real-world shape reported from production: owner known, Hunter finds a
// direct address with a 95 score, and the agency's mail server answers
// UNKNOWN or accept-all for everything. Weaker contacts on that SAME server
// would answer the same way, so no further credits may be spent.
function seedStantonHockett(store, { agency_id = 'ag_sh' } = {}) {
  seedAgency(store, {
    agency_id, agency_name: 'Stanton Hockett', domain: 'stantonhockett.co.uk', probe_sent: 'YES',
    owner_md: 'Bradley Stanton', primary_contact_email: 'hello@stantonhockett.co.uk',
  });
  seedCommunication(store, {
    communication_id: `com_${agency_id}`, agency_id, channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'terry@stantonhockett.co.uk', display_name: 'Terry Hockett',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
}

// score 95 -> the address Hunter proposes for Bradley Stanton. Note "brad@" is
// a diminutive that no name-matching rule would connect to "Bradley": the
// attribution comes from Hunter having been ASKED for that person.
const stantonHunter = () => makeHunter({ email: 'brad@stantonhockett.co.uk', score: 95, position: 'Managing Director' });

for (const [status, expectedCaution] of [['VALID', false], ['UNKNOWN', true], ['RISKY', true]]) {
  await test(`high-confidence owner + ${status} -> selected on one NeverBounce call`, async () => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedStantonHockett(store);
    const verifier = makeVerifier({ 'brad@stantonhockett.co.uk': status });
    const hunter = stantonHunter();
    const result = await resolveAgencyContact(repo, 'ag_sh', baseOptions({
      verifyEmailImpl: verifier, findEmailImpl: hunter,
    }));

    assert.equal(result.hunter.high_confidence, true);
    assert.equal(result.hunter.caution_rule_applies, true);
    // EXACTLY one credit spent, and it was the owner's address.
    assert.deepEqual(verifier.calls, ['brad@stantonhockett.co.uk']);
    assert.equal(result.neverbounce.calls_made, 1);
    // The weaker contacts on the same server are never checked.
    assert.ok(result.neverbounce.not_verified_after_winner.includes('terry@stantonhockett.co.uk'));
    assert.ok(result.neverbounce.not_verified_after_winner.includes('hello@stantonhockett.co.uk'));

    assert.equal(result.selected_contact.email, 'brad@stantonhockett.co.uk');
    assert.equal(result.selected_contact.contact_name, 'Bradley Stanton');
    assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
    // The REAL status is preserved — never upgraded to VALID.
    assert.equal(result.selected_contact.verification_status, status);
    assert.equal(result.selected_contact.selected_on_caution, expectedCaution);
    assert.equal(result.selected_contact.fully_verified, status === 'VALID');

    const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
    assert.equal(agency.outreach_contact_name, 'Bradley Stanton');
    assert.equal(agency.outreach_contact_email, 'brad@stantonhockett.co.uk');
    assert.equal(agency.email_verification_status, status, 'AGENCIES must carry the real status');
    assert.equal(agency.contact_resolution_status, 'RESOLVED_DIRECT');

    const selected = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER)
      .find((c) => c.is_selected_for_outreach === 'TRUE');
    assert.equal(selected.email, 'brad@stantonhockett.co.uk');
    assert.equal(selected.verification_status, status, 'CONTACTS must carry the real status');
    if (expectedCaution) {
      assert.match(selected.notes, /NOT fully verified/);
      assert.match(selected.notes, /Hunter score 95/);
    } else {
      assert.ok(!/NOT fully verified/.test(selected.notes));
    }
  });
}

for (const status of ['INVALID', 'DISPOSABLE']) {
  await test(`high-confidence owner + ${status} is rejected and the waterfall continues`, async () => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedStantonHockett(store);
    const verifier = makeVerifier({
      'brad@stantonhockett.co.uk': status,
      'terry@stantonhockett.co.uk': 'VALID',
    });
    const result = await resolveAgencyContact(repo, 'ag_sh', baseOptions({
      verifyEmailImpl: verifier, findEmailImpl: stantonHunter(),
    }));

    // A hard fail is never softened by confidence.
    assert.deepEqual(verifier.calls, ['brad@stantonhockett.co.uk', 'terry@stantonhockett.co.uk']);
    assert.equal(result.selected_contact.email, 'terry@stantonhockett.co.uk');
    assert.equal(result.selected_contact.verification_status, 'VALID');
    assert.equal(result.selected_contact.selected_on_caution, false);
    const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
    const rejected = contacts.find((c) => c.email === 'brad@stantonhockett.co.uk');
    assert.equal(rejected.verification_status, status);
    assert.equal(rejected.is_selected_for_outreach, 'FALSE');
  });
}

await test('low-confidence Hunter owner + UNKNOWN keeps the ordinary waterfall', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedStantonHockett(store);
  // Below the threshold: a pattern guess, not an observed address.
  const hunter = makeHunter({ email: 'brad@stantonhockett.co.uk', score: 62, position: '' });
  const verifier = makeVerifier({
    'brad@stantonhockett.co.uk': 'UNKNOWN',
    'terry@stantonhockett.co.uk': 'UNKNOWN',
    'hello@stantonhockett.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_sh', baseOptions({
    verifyEmailImpl: verifier, findEmailImpl: hunter,
  }));

  assert.equal(result.hunter.high_confidence, false);
  assert.equal(result.hunter.caution_rule_applies, false);
  // UNKNOWN did NOT stop the waterfall: every candidate was tried in order.
  assert.deepEqual(verifier.calls, [
    'brad@stantonhockett.co.uk', 'terry@stantonhockett.co.uk', 'hello@stantonhockett.co.uk',
  ]);
  assert.equal(result.selected_contact.email, 'hello@stantonhockett.co.uk');
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
});

await test('the high-confidence threshold is an explicit, overridable boundary', async () => {
  assert.equal(HUNTER_HIGH_CONFIDENCE_SCORE, 90);

  const runAtScore = async (score, overrides = {}) => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedStantonHockett(store);
    return resolveAgencyContact(repo, 'ag_sh', baseOptions({
      verifyEmailImpl: makeVerifier({
        'brad@stantonhockett.co.uk': 'UNKNOWN',
        'terry@stantonhockett.co.uk': 'UNKNOWN',
        'hello@stantonhockett.co.uk': 'UNKNOWN',
      }),
      findEmailImpl: makeHunter({ email: 'brad@stantonhockett.co.uk', score }),
      ...overrides,
    }));
  };

  // Exactly at the threshold qualifies; one below does not.
  assert.equal((await runAtScore(90)).selected_contact?.email, 'brad@stantonhockett.co.uk');
  assert.equal((await runAtScore(89)).selected_contact, null);
  // A missing score is never high confidence.
  assert.equal((await runAtScore(null)).selected_contact, null);
  // ...and the boundary can be retuned per call without a code change.
  const retuned = await runAtScore(80, { hunterHighConfidenceScore: 75 });
  assert.equal(retuned.hunter.high_confidence_threshold, 75);
  assert.equal(retuned.selected_contact.email, 'brad@stantonhockett.co.uk');
});

await test('a non-owner Hunter hit does not get the caution rule', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_dir', agency_name: 'Partner Estates', domain: 'partnerestates.co.uk',
    primary_contact_email: 'hello@partnerestates.co.uk',
  });
  // Research identifies a DIRECTOR, not the owner/MD.
  const research = async () => ({
    found: true, person_name: 'Dana Reeve', role: 'DIRECTOR', role_title: 'Director',
    evidence: 'Listed as a director at Companies House.',
    source_url: 'https://find-and-update.company-information.service.gov.uk/x',
    source_type: 'COMPANIES_HOUSE', confidence: 'HIGH',
  });
  const verifier = makeVerifier({
    'dana.reeve@partnerestates.co.uk': 'UNKNOWN',
    'hello@partnerestates.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_dir', baseOptions({
    verifyEmailImpl: verifier,
    findEmailImpl: makeHunter({ email: 'dana.reeve@partnerestates.co.uk', score: 98 }),
    researchOwnerImpl: research,
  }));

  assert.equal(result.hunter.high_confidence, true, 'the score itself is high');
  assert.equal(result.hunter.caution_rule_applies, false, 'but a director is not the owner/MD tier');
  assert.equal(result.selected_contact.email, 'hello@partnerestates.co.uk');
});

await test('a cached inconclusive result selects a high-confidence owner with no new call', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedStantonHockett(store);
  seedContact(store, {
    contact_id: 'cnt_cached', agency_id: 'ag_sh', email: 'brad@stantonhockett.co.uk',
    contact_name: 'Bradley Stanton', email_source: 'HUNTER', contact_type: 'DIRECT',
    verification_status: 'RISKY', verified_at: '2026-08-20T09:00:00.000Z',
    is_selected_for_outreach: 'FALSE', created_at: '2026-08-20T09:00:00.000Z',
  });
  const verifier = makeVerifier({});
  const result = await resolveAgencyContact(repo, 'ag_sh', baseOptions({
    verifyEmailImpl: verifier, findEmailImpl: stantonHunter(),
  }));

  assert.equal(verifier.calls.length, 0, 'no credit spent at all');
  assert.equal(result.selected_contact.email, 'brad@stantonhockett.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  assert.equal(result.selected_contact.selected_on_caution, true);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
});

// ── Backlog preparation is inert ────────────────────────────────────────────
await test('backlog listing covers probed-unresolved agencies only and resolves nothing', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, { agency_id: 'ag_p1', agency_name: 'Probed Unresolved', probe_sent: 'YES' });
  seedAgency(store, { agency_id: 'ag_p2', agency_name: 'Probed Resolved', probe_sent: 'YES', contact_resolution_status: 'RESOLVED_DIRECT' });
  seedAgency(store, { agency_id: 'ag_u1', agency_name: 'Never Probed', probe_sent: '' });

  const backlog = await listResolutionBacklog(repo);
  assert.deepEqual(backlog.map((a) => a.agency_id), ['ag_p1']);
  const all = await listResolutionBacklog(repo, { includeResolved: true });
  assert.deepEqual(all.map((a) => a.agency_id), ['ag_p1', 'ag_p2']);
  // Nothing was written by listing.
  assert.equal(rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER).length, 0);
});

// ── Serverless Function count must not increase ─────────────────────────────
await test('Vercel Serverless Function count stays at 12 or fewer', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      // Vercel treats every non-underscore .js/.mjs/.ts file under /api as a
      // Serverless Function; _-prefixed files are shared helpers, not routes.
      if (!/\.(js|mjs|ts)$/.test(entry.name)) continue;
      if (entry.name.startsWith('_')) continue;
      found.push(path.relative(root, full));
    }
  })(path.join(root, 'api'));

  assert.ok(found.length <= 12, `Expected <= 12 Serverless Functions, found ${found.length}:\n${found.join('\n')}`);
  // Contact resolution must be an operation on an existing function, never a
  // new route file.
  assert.ok(!found.some((f) => /contacts?/i.test(f)), 'contact resolution must not add its own function file');
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const sources = vercelConfig.rewrites.map((r) => r.source);
  assert.ok(sources.includes('/api/novus/contacts/resolve'));
  console.log(`      (${found.length} Serverless Functions)`);
});

// ── The HTTP action itself ──────────────────────────────────────────────────
await test('POST /api/novus/contacts/resolve is protected and returns the full trace', async () => {
  process.env.NOVUS_BASIC_AUTH_USER = 'novus-test';
  process.env.NOVUS_BASIC_AUTH_PASS = 'password-test';
  const { store, valuesApi } = makeFakeSheet();
  seedAgency(store, {
    agency_id: 'ag_api', agency_name: 'API Estates', domain: 'apiestates.co.uk', probe_sent: 'YES',
    owner_md: 'Nina Api', primary_contact_email: 'nina.api@apiestates.co.uk',
  });
  const sheets = await import('../lib/sheets.mjs');
  sheets.__setRepoForTests(createRepo(valuesApi));
  const neverbounce = await import('../lib/neverbounce.mjs');
  const hunter = await import('../lib/hunter.mjs');
  const handler = (await import('../api/novus/personalisation.js')).default;

  const mockRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
    setHeader() { return this; },
  });

  // Unauthenticated request is rejected before any Sheets access.
  const unauth = mockRes();
  await handler({ method: 'POST', query: { novus_operation: 'resolve-contact' }, body: { agency_id: 'ag_api' }, headers: {} }, unauth);
  assert.equal(unauth.statusCode, 401);

  const authHeader = `Basic ${Buffer.from('novus-test:password-test').toString('base64')}`;

  // Missing agency_id.
  const bad = mockRes();
  await handler({ method: 'POST', query: { novus_operation: 'resolve-contact' }, body: {}, headers: { authorization: authHeader } }, bad);
  assert.equal(bad.statusCode, 400);

  // Happy path — stub the real providers this handler reaches for.
  const realVerify = neverbounce.verifyEmail;
  const realFind = hunter.findEmail;
  const originalFetch = globalThis.fetch;
  process.env.NEVERBOUNCE_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success', result: 'valid' }) });

  const ok = mockRes();
  await handler({ method: 'POST', query: { novus_operation: 'resolve-contact' }, body: { agency_id: 'ag_api' }, headers: { authorization: authHeader } }, ok);
  assert.equal(ok.statusCode, 200);
  for (const key of ['agency', 'owner_md', 'candidates_considered', 'candidates_verified',
    'neverbounce', 'hunter', 'selected_contact', 'contact_resolution_status']) {
    assert.ok(key in ok.body, `response must include ${key}`);
  }
  assert.equal(ok.body.selected_contact.email, 'nina.api@apiestates.co.uk');
  assert.equal(ok.body.contact_resolution_status, 'RESOLVED_DIRECT');

  // Unknown agency -> 404, not a 500.
  const missing = mockRes();
  await handler({ method: 'POST', query: { novus_operation: 'resolve-contact' }, body: { agency_id: 'nope' }, headers: { authorization: authHeader } }, missing);
  assert.equal(missing.statusCode, 404);

  // The backlog listing route reports without resolving.
  const backlog = mockRes();
  await handler({ method: 'GET', query: { novus_operation: 'resolution-backlog' }, headers: { authorization: authHeader } }, backlog);
  assert.equal(backlog.statusCode, 200);
  assert.equal(typeof backlog.body.count, 'number');

  globalThis.fetch = originalFetch;
  sheets.__setRepoForTests(null);
  assert.equal(neverbounce.verifyEmail, realVerify);
  assert.equal(hunter.findEmail, realFind);
});

console.log(`\n${passed} contact-resolution checks passed.`);
