// scripts/novus-contact-resolution-selftest.mjs — hermetic contact-resolution
// tests (no network, no creds, no live provider calls).
//
// Exercises the REAL code paths — lib/contact-resolution.mjs and the
// /api/novus/contacts/resolve handler inside api/novus/personalisation.js —
// against an in-memory fake of the Google Sheets values API in the live
// workbook's shape (row 1 = header, row 2 = SCHEMA NOTE, row 3+ = data).
//
// Hunter verification, domain search and email finding are injected as fakes, so every
// assertion here is about the waterfall/persistence logic, never about a
// provider. The counters those fakes keep are load-bearing: several tests
// assert on how many times a provider WOULD have been called.
//
// Run:  npm run novus:contact-resolution-selftest

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo, fetchSheetsJson } from '../lib/sheets.mjs';
import {
  resolveAgencyContact,
  listResolutionBacklog,
  buildCandidates,
  buildVerificationCache,
  isGenericEmail,
  isAutomatedSender,
  nameMatchesLocalPart,
  verdictForCandidate,
  resolveHeaderName,
  verifierProofNote,
  MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY,
  HUNTER_HIGH_CONFIDENCE_SCORE,
  rankHunterDecisionMaker,
  selectHunterDecisionMaker,
  HARD_FAIL_STATUSES,
  INCONCLUSIVE_STATUSES,
  PRIORITY,
} from '../lib/contact-resolution.mjs';
import {
  normalizeHunterVerificationStatus,
  findDomainDecisionMakers,
  findDomainGenericEmails,
  findEmail as findHunterEmail,
  verifyEmail as verifyHunterEmail,
} from '../lib/hunter.mjs';
import {
  CONFIRMATION as RECHECK_CONFIRMATION,
  isEligibleAgency as isRecheckEligible,
  main as runNeedsResearchRecheck,
  parseArgs as parseRecheckArgs,
  partitionNeedsResearch,
  requestJson as recheckRequestJson,
} from './novus-contact-resolution-blank-status-run.mjs';

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
  const calls = { get: [], append: [], update: [], batchUpdate: [] };

  const applyUpdate = (range, rows) => {
    const tab = tabOf(range);
    const start = startRowOf(range);
    const col = colIndex(colOf(range));
    store[tab] = store[tab] || [];
    rows.forEach((r, i) => {
      const rowIdx = start - 1 + i;
      if (col === 0 && r.length > 1) {
        store[tab][rowIdx] = r.slice(); // full-row write
      } else {
        const existing = store[tab][rowIdx] || [];
        while (existing.length <= col) existing.push('');
        existing[col] = r[0];           // single-cell write
        store[tab][rowIdx] = existing;
      }
    });
  };

  const valuesApi = {
    async get(range) {
      calls.get.push(range);
      return (store[tabOf(range)] || []).map((r) => r.slice());
    },
    async append(range, rows) {
      calls.append.push(range);
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      calls.update.push(range);
      applyUpdate(range, rows);
      return { updatedRows: rows.length };
    },
    async batchUpdate(data) {
      calls.batchUpdate.push(data.map((item) => item.range));
      for (const item of data) applyUpdate(item.range, item.values);
      return { totalUpdatedRanges: data.length };
    },
  };
  return { store, valuesApi, calls };
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
    const status = typeof configured === 'object'
      ? (configured.verification_status || configured.status || defaultStatus)
      : (configured || defaultStatus);
    return {
      verification_status: status,
      score: typeof configured === 'object' ? (configured.score ?? null) : null,
      raw_result: { data: { status, score: typeof configured === 'object' ? (configured.score ?? null) : null } },
    };
  };
  impl.calls = calls;
  return impl;
}
function makeHunter(result) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    if (!result) return result;
    return {
      verification_status: 'VALID',
      verification_date: '2026-08-26',
      raw_result: { data: { verification: { status: result.verification_status || 'valid' } } },
      ...result,
    };
  };
  impl.calls = calls;
  return impl;
}
function makeDomainSearch(result = []) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  impl.calls = calls;
  return impl;
}
const clock = () => '2026-08-26T12:00:00.000Z';

function baseOptions(overrides = {}) {
  return {
    verifyEmailImpl: makeVerifier({}),
    findEmailImpl: makeHunter(null),
    // Most legacy waterfall tests are not about identity discovery. Give them
    // a Hunter-classified decision-maker without an address so they continue
    // to exercise Finder/Verifier behavior; blank-owner miss tests override it.
    findDomainDecisionMakersImpl: makeDomainSearch([{
      full_name: 'Test Decision Maker', position: 'Director', decision_maker: true,
    }]),
    findDomainGenericEmailsImpl: makeDomainSearch(),
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
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('info@haleandco.co.uk'));

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
  // Finder found the address; the EMAIL VERIFIER is what decides it, and it is
  // called on this best candidate explicitly before selection.
  assert.deepEqual(verifier.calls, ['marie.bell@bellestates.co.uk']);
  assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 1);
  assert.deepEqual(result.hunter_verifier.emails_verified, ['marie.bell@bellestates.co.uk']);
  assert.equal(result.candidates_verified[0].verification_provider, 'HUNTER_VERIFIER');
  assert.equal(result.candidates_verified[0].verifier_proof, true);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 'marie.bell@bellestates.co.uk');
  assert.equal(result.selected_contact.email_source, 'HUNTER');
  // The winner outranks the generic inbox, so the inbox is never checked.
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('info@bellestates.co.uk'));
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
await test('UNKNOWN moves to the next candidate; a RISKY owner-direct then outranks a VALID generic fallback', async () => {
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

  // UNKNOWN on #1 moves on to #2. #2 is an owner-direct contact (t.ridge@
  // matches "Tom Ridge"), so its RISKY result now wins outright — ranking
  // policy: RISKY owner/senior direct outranks a VALID generic inbox, so the
  // generic office@ (#3) is never even checked.
  assert.deepEqual(verifier.calls, ['tom.ridge@ridgevale.co.uk', 't.ridge@ridgevale.co.uk']);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 't.ridge@ridgevale.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  const statuses = Object.fromEntries(result.candidates_verified.map((v) => [v.email, v.verification_status]));
  assert.equal(statuses['tom.ridge@ridgevale.co.uk'], 'UNKNOWN');
  assert.equal(statuses['t.ridge@ridgevale.co.uk'], 'RISKY');
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('office@ridgevale.co.uk'));
});

// ── Flow 6: everything fails ────────────────────────────────────────────────
await test('all direct and generic candidates failing gives NEEDS_RESEARCH and no selected contact', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_6', agency_name: 'Falls Estates', domain: 'fallsestates.co.uk', probe_sent: 'YES',
    owner_md: 'Ruth Falls', primary_contact_email: 'ruth.falls@fallsestates.co.uk',
    other_known_emails: 'info@fallsestates.co.uk',
  });
  const verifier = makeVerifier({}, { defaultStatus: 'INVALID' });
  const result = await resolveAgencyContact(repo, 'ag_6', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(result.contact_resolution_status, 'NEEDS_RESEARCH');
  assert.equal(result.selected_contact, null);
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.contact_resolution_status, 'NEEDS_RESEARCH');
  assert.equal(agency.outreach_contact_email, '');
  assert.equal(agency.email_verification_status, '');
  const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((c) => c.is_selected_for_outreach === 'FALSE'));
});

// ── Flow 7: a PROVEN stored verification avoids a repeat Hunter call ───────
await test('a recent stored verifier result is reused instead of calling Hunter', async () => {
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
    // Proof that the Email Verifier itself produced that VALID.
    notes: verifierProofNote('VALID', '2026-08-20T09:00:00.000Z'),
    is_selected_for_outreach: 'FALSE', created_at: '2026-08-20T09:00:00.000Z',
  });
  const verifier = makeVerifier({ 'ella.marsh@marshhomes.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_7', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(verifier.calls.length, 0, 'Hunter must not be called again for a fresh result');
  assert.equal(result.hunter_verifier.calls_made, 0);
  assert.equal(result.hunter_verifier.cached_reuses, 1);
  assert.equal(result.candidates_verified[0].cached, true);
  assert.equal(result.candidates_verified[0].verifier_proof, true);
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');

  // ...and a stale result is NOT reused.
  const stale = buildVerificationCache(
    [{ obj: { email: 'old@x.co.uk', verification_status: 'VALID',
      verified_at: '2020-01-01T00:00:00.000Z', notes: verifierProofNote('VALID', '2020-01-01T00:00:00.000Z') } }],
    { now: Date.parse(clock()) },
  );
  assert.equal(stale.size, 0);

  // ...nor is a recent result with no proof that the verifier produced it.
  const unproven = buildVerificationCache(
    [{ obj: { email: 'old@x.co.uk', verification_status: 'VALID', verified_at: '2026-08-20T09:00:00.000Z' } }],
    { now: Date.parse(clock()) },
  );
  assert.equal(unproven.size, 0, 'an unproven stored status is not a verification');

  // ...and an explicit provider column counts as proof if the workbook has one.
  const byProvider = buildVerificationCache(
    [{ obj: { email: 'old@x.co.uk', verification_status: 'VALID',
      verified_at: '2026-08-20T09:00:00.000Z', verification_provider: 'HUNTER_VERIFIER' } }],
    { now: Date.parse(clock()) },
  );
  assert.equal(byProvider.size, 1);
});

// ── Flow 7b: an UNPROVEN stored status is re-verified ──────────────────────
//
// THE REPORTED BUG: a CONTACTS row carrying VALID/RISKY/UNKNOWN that no Hunter
// Email Verifier call ever produced. There is no proof, so the next run checks
// it for real rather than inheriting the status.
await test('a stored status with no verifier proof is re-verified on the next run', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_7b', agency_name: 'Unproven Homes', domain: 'unproven.co.uk', probe_sent: 'YES',
    owner_md: 'Ida Unproven', primary_contact_email: 'ida.unproven@unproven.co.uk',
  });
  seedContact(store, {
    contact_id: 'cnt_unproven', agency_id: 'ag_7b', email: 'ida.unproven@unproven.co.uk',
    contact_name: 'Ida Unproven', email_source: 'HUNTER', contact_type: 'DIRECT',
    // Written by an earlier run from Finder metadata — never verifier-checked.
    verification_status: 'VALID', verified_at: '2026-08-20T09:00:00.000Z',
    notes: 'Hunter email finder for Ida Unproven @ unproven.co.uk (score 94)',
    is_selected_for_outreach: 'FALSE', created_at: '2026-08-20T09:00:00.000Z',
  });
  const verifier = makeVerifier({ 'ida.unproven@unproven.co.uk': 'INVALID' });
  const result = await resolveAgencyContact(repo, 'ag_7b', baseOptions({
    verifyEmailImpl: verifier, hunterConfigured: () => false,
  }));

  assert.deepEqual(verifier.calls, ['ida.unproven@unproven.co.uk']);
  assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 1);
  // The real verdict replaces the unproven one, and the row now carries proof.
  assert.equal(result.selected_contact, null);
  const row = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === 'ida.unproven@unproven.co.uk');
  assert.equal(row.verification_status, 'INVALID');
  assert.match(row.notes, /\[hunter_verifier:INVALID@/);

  // A second run reuses that proven result instead of paying again.
  const verifier2 = makeVerifier({ 'ida.unproven@unproven.co.uk': 'INVALID' });
  await resolveAgencyContact(repo, 'ag_7b', baseOptions({
    verifyEmailImpl: verifier2, hunterConfigured: () => false,
  }));
  assert.equal(verifier2.calls.length, 0, 'a proven result is reusable');
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
await test('no Hunter named contact plus a valid stored generic resolves generically', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_10', agency_name: 'Anon Estates', domain: 'anonestates.co.uk', probe_sent: 'YES',
    owner_md: '', primary_contact_email: 'info@anonestates.co.uk',
  });
  const finder = makeHunter({ email: 'never@used.co.uk' });
  const domainSearch = makeDomainSearch([]);
  const genericSearch = makeDomainSearch([]);
  const verifier = makeVerifier({ 'info@anonestates.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_10', baseOptions({
    verifyEmailImpl: verifier,
    findEmailImpl: finder,
    findDomainDecisionMakersImpl: domainSearch,
    findDomainGenericEmailsImpl: genericSearch,
  }));

  // No external fallback research: the existing generic goes through Hunter
  // Verifier and is persisted as the second-stage winner.
  assert.equal(result.owner_md.value, '');
  assert.deepEqual(domainSearch.calls, [{ domain: 'anonestates.co.uk' }]);
  assert.equal(finder.calls.length, 0);
  assert.deepEqual(genericSearch.calls, [{ domain: 'anonestates.co.uk' }]);
  assert.deepEqual(verifier.calls, ['info@anonestates.co.uk']);
  assert.equal(result.hunter_verifier.calls_made, 1);
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
  assert.equal(result.selected_contact.email, 'info@anonestates.co.uk');
  assert.equal(result.selected_contact.contact_name, '');
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.owner_md, '');
  assert.equal(agency.outreach_contact_name, '');
  assert.equal(agency.outreach_contact_email, 'info@anonestates.co.uk');
  assert.equal(agency.email_verification_status, 'VALID');
});

await test('no Hunter named contact plus a Hunter generic result resolves generically', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_hunter_generic', agency_name: 'Hunter Generic', domain: 'huntergeneric.co.uk',
  });
  const verifier = makeVerifier({ 'sales@huntergeneric.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_hunter_generic', baseOptions({
    verifyEmailImpl: verifier,
    findDomainDecisionMakersImpl: makeDomainSearch([]),
    findDomainGenericEmailsImpl: makeDomainSearch([{
      email: 'sales@huntergeneric.co.uk', confidence: 91, verification_status: 'VALID',
    }]),
  }));
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
  assert.equal(result.selected_contact.email, 'sales@huntergeneric.co.uk');
  assert.equal(result.selected_contact.email_source, 'HUNTER_DOMAIN_SEARCH');
  assert.equal(result.selected_contact.contact_name, '');
  assert.deepEqual(verifier.calls, ['sales@huntergeneric.co.uk']);
});

await test('blank owner_md with nothing usable is NEEDS_RESEARCH', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_10b', agency_name: 'Empty Estates', domain: 'emptyestates.co.uk', probe_sent: 'YES',
  });
  const verifier = makeVerifier({});
  const result = await resolveAgencyContact(repo, 'ag_10b', baseOptions({
    verifyEmailImpl: verifier,
    findDomainDecisionMakersImpl: makeDomainSearch([]),
    findDomainGenericEmailsImpl: makeDomainSearch([]),
  }));
  assert.equal(result.candidates_considered.length, 0);
  assert.equal(verifier.calls.length, 0);
  assert.equal(result.contact_resolution_status, 'NEEDS_RESEARCH');
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.contact_resolution_status, 'NEEDS_RESEARCH');
});

await test('an existing valid direct contact is not downgraded to generic when Hunter names nobody', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_existing_direct', agency_name: 'Existing Direct', domain: 'existingdirect.co.uk',
    primary_contact_email: 'info@existingdirect.co.uk',
  });
  seedCommunication(store, {
    communication_id: 'com_existing_direct', agency_id: 'ag_existing_direct', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'alex.senior@existingdirect.co.uk', display_name: 'Alex Senior, Director',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const verifier = makeVerifier({
    'alex.senior@existingdirect.co.uk': 'VALID',
    'info@existingdirect.co.uk': 'VALID',
  });
  const genericSearch = makeDomainSearch([{ email: 'sales@existingdirect.co.uk' }]);
  const result = await resolveAgencyContact(repo, 'ag_existing_direct', baseOptions({
    verifyEmailImpl: verifier,
    findDomainDecisionMakersImpl: makeDomainSearch([]),
    findDomainGenericEmailsImpl: genericSearch,
  }));
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email, 'alex.senior@existingdirect.co.uk');
  assert.deepEqual(verifier.calls, ['alex.senior@existingdirect.co.uk']);
  assert.equal(genericSearch.calls.length, 0, 'generic discovery is not reached after a direct winner');
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.outreach_contact_email, 'alex.senior@existingdirect.co.uk');
});

// ── Flow 11: Hunter Domain Search finds a decision-maker ────────────────────
await test('Hunter Domain Search selects and resolves the preferred named decision-maker', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_11', agency_name: 'Kestrel & Co', domain: 'kestrelco.co.uk', probe_sent: 'YES',
    owner_md: '', primary_contact_email: 'info@kestrelco.co.uk', notes: 'Existing note.',
  });
  const domainSearch = makeDomainSearch([
    { full_name: 'Sam Senior', position: 'Chief Operating Officer', email: 'sam@kestrelco.co.uk', decision_maker: true, confidence: 99 },
    { full_name: 'Helen Kestrel', position: 'Managing Director', email: 'helen.kestrel@kestrelco.co.uk', decision_maker: true, confidence: 88 },
  ]);
  const finder = makeHunter({ email: 'never@used.co.uk' });
  const result = await resolveAgencyContact(repo, 'ag_11', baseOptions({
    verifyEmailImpl: makeVerifier({ 'helen.kestrel@kestrelco.co.uk': 'VALID' }),
    findEmailImpl: finder,
    findDomainDecisionMakersImpl: domainSearch,
  }));

  assert.equal(result.owner_md.value, 'Helen Kestrel');
  assert.equal(result.owner_md.was_blank, true);
  assert.equal(result.owner_md.source, 'HUNTER_DOMAIN_SEARCH');
  assert.equal(result.owner_md.research, null);
  assert.equal(finder.calls.length, 0, 'Domain Search already supplied the address');
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(result.selected_contact.email_source, 'HUNTER_DOMAIN_SEARCH');

  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.owner_md, '', 'contact resolution does not mutate owner_md');
  assert.match(agency.notes, /Existing note\./);
});

await test('Hunter decision-maker roles follow the required preference order', () => {
  const people = [
    { full_name: 'P Principal', position: 'Principal', decision_maker: true },
    { full_name: 'D Director', position: 'Director', decision_maker: true },
    { full_name: 'F Founder', position: 'Co-Founder', decision_maker: true },
    { full_name: 'O Owner', position: 'Owner', decision_maker: true },
  ];
  assert.equal(rankHunterDecisionMaker({ position: 'Branch Owner', decision_maker: true }), 7);
  assert.equal(selectHunterDecisionMaker(people).full_name, 'O Owner');
  assert.equal(selectHunterDecisionMaker([{ full_name: 'J Junior', position: 'Negotiator', decision_maker: false }]), null);
});

// ── Hunter verdict vocabulary ───────────────────────────────────────────────
await test('Hunter results map to five distinct NOVUS statuses', () => {
  assert.equal(normalizeHunterVerificationStatus('valid'), 'VALID');
  assert.equal(normalizeHunterVerificationStatus('webmail'), 'VALID');
  assert.equal(normalizeHunterVerificationStatus('invalid'), 'INVALID');
  // DISPOSABLE is its own verdict now, no longer flattened into INVALID.
  assert.equal(normalizeHunterVerificationStatus('disposable'), 'DISPOSABLE');
  assert.equal(normalizeHunterVerificationStatus('unknown'), 'UNKNOWN');
  assert.equal(normalizeHunterVerificationStatus('blocked'), 'UNKNOWN');
  // Accept-all/catchall in every spelling is RISKY — never a hard failure.
  for (const spelling of ['catchall', 'catch_all', 'catch-all', 'accept_all', 'accept-all', 'accepts_all']) {
    assert.equal(normalizeHunterVerificationStatus(spelling), 'RISKY', spelling);
  }
  assert.ok(!HARD_FAIL_STATUSES.has('RISKY'), 'accept-all must never be a hard failure');
  assert.ok(!HARD_FAIL_STATUSES.has('UNKNOWN'));
  assert.deepEqual([...HARD_FAIL_STATUSES].sort(), ['DISPOSABLE', 'INVALID']);
  assert.deepEqual([...INCONCLUSIVE_STATUSES].sort(), ['RISKY', 'UNKNOWN']);
});

await test('Hunter Finder exposes its embedded verdict and Email Verifier normalises its own response', async () => {
  const originalKey = process.env.HUNTER_API_KEY;
  process.env.HUNTER_API_KEY = 'test-key';
  try {
    let finderUrl;
    const found = await findHunterEmail({ name: 'Marie Bell', domain: 'bellestates.co.uk' }, {
      fetchImpl: async (url) => {
        finderUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: {
            email: 'marie.bell@bellestates.co.uk', score: 88, accept_all: true,
            verification: { status: 'valid', date: '2026-08-25' },
          } }),
        };
      },
    });
    assert.equal(finderUrl.pathname, '/v2/email-finder');
    assert.equal(found.verification_status, 'RISKY', 'accept_all overrides a nominal valid mailbox result');
    assert.equal(found.verification_date, '2026-08-25');

    let verifierUrl;
    const verified = await verifyHunterEmail('person@example.com', {
      fetchImpl: async (url) => {
        verifierUrl = url;
        return { ok: true, status: 200, json: async () => ({ data: { status: 'accept_all', score: 82 } }) };
      },
    });
    assert.equal(verifierUrl.pathname, '/v2/email-verifier');
    assert.equal(verified.verification_status, 'RISKY');
    assert.equal(verified.score, 82);
  } finally {
    if (originalKey === undefined) delete process.env.HUNTER_API_KEY;
    else process.env.HUNTER_API_KEY = originalKey;
  }
});

await test('Hunter Domain Search requests named personal decision-makers and normalises them', async () => {
  const originalKey = process.env.HUNTER_API_KEY;
  process.env.HUNTER_API_KEY = 'test-key';
  try {
    let requestedUrl;
    const people = await findDomainDecisionMakers({ domain: 'Example.co.uk' }, {
      fetchImpl: async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { emails: [{
            value: 'alex.owner@example.co.uk', first_name: 'Alex', last_name: 'Owner',
            position: 'Owner', decision_maker: true, confidence: 96,
            verification: { status: 'valid', date: '2026-08-25' },
          }] } }),
        };
      },
    });
    assert.equal(requestedUrl.pathname, '/v2/domain-search');
    assert.equal(requestedUrl.searchParams.get('domain'), 'example.co.uk');
    assert.equal(requestedUrl.searchParams.get('type'), 'personal');
    assert.equal(requestedUrl.searchParams.get('decision_maker'), 'true');
    assert.equal(requestedUrl.searchParams.get('required_field'), 'full_name,position');
    assert.deepEqual(people.map(({ full_name, position, email, decision_maker }) => ({ full_name, position, email, decision_maker })), [{
      full_name: 'Alex Owner', position: 'Owner', email: 'alex.owner@example.co.uk', decision_maker: true,
    }]);
  } finally {
    if (originalKey === undefined) delete process.env.HUNTER_API_KEY;
    else process.env.HUNTER_API_KEY = originalKey;
  }
});

await test('Hunter generic Domain Search requests generic addresses only', async () => {
  const originalKey = process.env.HUNTER_API_KEY;
  process.env.HUNTER_API_KEY = 'test-key';
  try {
    let requestedUrl;
    const emails = await findDomainGenericEmails({ domain: 'Example.co.uk' }, {
      fetchImpl: async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { emails: [{ value: 'sales@example.co.uk', type: 'generic', confidence: 90 }] } }),
        };
      },
    });
    assert.equal(requestedUrl.pathname, '/v2/domain-search');
    assert.equal(requestedUrl.searchParams.get('type'), 'generic');
    assert.equal(requestedUrl.searchParams.has('decision_maker'), false);
    assert.equal(emails[0].email, 'sales@example.co.uk');
  } finally {
    if (originalKey === undefined) delete process.env.HUNTER_API_KEY;
    else process.env.HUNTER_API_KEY = originalKey;
  }
});

await test('verdictForCandidate: caution rule softens only inconclusive verdicts', () => {
  // Hunter-Finder-sourced candidates are gated on Finder's own attribution
  // score: strong and senior earns the accept-all; ordinary/weak does not.
  const strong = { type: 'DIRECT', source: 'HUNTER', clearly_senior_direct: true, hunter_score: 95 };
  const ordinary = { type: 'DIRECT', source: 'HUNTER', clearly_senior_direct: false, hunter_score: 60 };
  const generic = { type: 'GENERIC', clearly_senior_direct: false };
  assert.equal(verdictForCandidate(strong, 'VALID'), 'SELECT');
  assert.equal(verdictForCandidate(strong, 'UNKNOWN'), 'CONTINUE');
  assert.equal(verdictForCandidate(strong, 'RISKY'), 'SELECT');
  assert.equal(verdictForCandidate(strong, 'INVALID'), 'REJECT');
  assert.equal(verdictForCandidate(strong, 'DISPOSABLE'), 'REJECT');
  assert.equal(verdictForCandidate(ordinary, 'VALID'), 'SELECT');
  assert.equal(verdictForCandidate(ordinary, 'UNKNOWN'), 'CONTINUE');
  assert.equal(verdictForCandidate(ordinary, 'RISKY'), 'CONTINUE');
  assert.equal(verdictForCandidate(ordinary, 'INVALID'), 'REJECT');
  assert.equal(verdictForCandidate(generic, 'RISKY'), 'SELECT');
  assert.equal(verdictForCandidate(generic, 'UNKNOWN'), 'CONTINUE');

  // A Hunter Finder hit with no score at all is never high confidence.
  const unscored = { type: 'DIRECT', source: 'HUNTER', clearly_senior_direct: true, hunter_score: null };
  assert.equal(verdictForCandidate(unscored, 'RISKY'), 'CONTINUE');

  // Discovered directly (AGENCIES/COMMUNICATIONS/CONTACTS), not by Hunter
  // Finder: no attribution score to weigh, so any identified, non-generic
  // contact (owner/senior/branch-manager down through named-human) is
  // selectable on RISKY without a further gate — ranking policy tier 2/4.
  const identifiedSenior = { type: 'DIRECT', source: 'AGENCIES.primary_contact_email', priority: PRIORITY.SENIOR_DIRECT, hunter_score: null };
  const identifiedNamed = { type: 'DIRECT', source: 'COMMUNICATIONS', priority: PRIORITY.NAMED_HUMAN, hunter_score: null };
  assert.equal(verdictForCandidate(identifiedSenior, 'RISKY'), 'SELECT');
  assert.equal(verdictForCandidate(identifiedNamed, 'RISKY'), 'SELECT');
  assert.equal(verdictForCandidate(identifiedSenior, 'UNKNOWN'), 'CONTINUE');
});

await test('generic Accept All is selected as RISKY only at the fallback tier', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_4b', agency_name: 'Fallback Homes', domain: 'fallback.co.uk',
    owner_md: 'Pippa Fall', primary_contact_email: 'pippa.fall@fallback.co.uk',
    other_known_emails: 'info@fallback.co.uk',
  });
  const verifier = makeVerifier({
    'pippa.fall@fallback.co.uk': 'INVALID',
    'info@fallback.co.uk': { status: 'RISKY', score: 25 },
  });
  const result = await resolveAgencyContact(repo, 'ag_4b', baseOptions({ verifyEmailImpl: verifier }));
  assert.deepEqual(verifier.calls, ['pippa.fall@fallback.co.uk', 'info@fallback.co.uk']);
  assert.equal(result.selected_contact.email, 'info@fallback.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
});

await test('Hunter Verifier Accept All score 80+ selects a clearly senior AGENCIES contact as RISKY', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_existing_risky', agency_name: 'Senior Homes', domain: 'seniorhomes.co.uk',
    owner_md: 'Sara Senior', primary_contact_email: 'sara.senior@seniorhomes.co.uk',
    other_known_emails: 'info@seniorhomes.co.uk',
  });
  const verifier = makeVerifier({
    'sara.senior@seniorhomes.co.uk': { status: 'RISKY', score: 80 },
  });
  const result = await resolveAgencyContact(repo, 'ag_existing_risky', baseOptions({ verifyEmailImpl: verifier }));
  assert.deepEqual(verifier.calls, ['sara.senior@seniorhomes.co.uk']);
  assert.equal(result.selected_contact.email, 'sara.senior@seniorhomes.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  assert.equal(result.hunter_verifier.calls_made, 1);
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('info@seniorhomes.co.uk'));
});

// ── High-confidence owner/MD caution rule, end to end ───────────────────────
//
// The real-world shape reported from production: owner known, Hunter finds a
// direct address with a 95 score, and the agency's mail server answers
// Accept-all with score 95. Weaker contacts on that SAME server must not be
// checked after this clearly senior direct winner.
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
const stantonHunter = (verificationStatus = 'VALID', score = 95) => makeHunter({
  email: 'brad@stantonhockett.co.uk', score, position: 'Managing Director',
  verification_status: verificationStatus,
});

for (const [status, expectedCaution] of [['VALID', false], ['RISKY', true]]) {
  await test(`high-confidence owner + Verifier ${status} -> selected after one verifier call`, async () => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedStantonHockett(store);
    // The Finder result is only a candidate; the VERIFIER decides it.
    const verifier = makeVerifier({ 'brad@stantonhockett.co.uk': status });
    const hunter = stantonHunter(status);
    const result = await resolveAgencyContact(repo, 'ag_sh', baseOptions({
      verifyEmailImpl: verifier, findEmailImpl: hunter,
    }));

    assert.equal(result.hunter.high_confidence, true);
    assert.equal(result.hunter.caution_rule_applies, true);
    // The best candidate is explicitly verified before it can be selected.
    assert.deepEqual(verifier.calls, ['brad@stantonhockett.co.uk']);
    assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 1);
    assert.deepEqual(result.hunter_verifier.emails_verified, ['brad@stantonhockett.co.uk']);
    assert.equal(result.candidates_verified[0].verification_provider, 'HUNTER_VERIFIER');
    // The weaker contacts on the same server are never checked.
    assert.ok(result.hunter_verifier.not_verified_after_winner.includes('terry@stantonhockett.co.uk'));
    assert.ok(result.hunter_verifier.not_verified_after_winner.includes('hello@stantonhockett.co.uk'));

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

await test('high-score Hunter UNKNOWN is not selected and the waterfall continues', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedStantonHockett(store);
  const verifier = makeVerifier({
    'brad@stantonhockett.co.uk': 'UNKNOWN',
    'terry@stantonhockett.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_sh', baseOptions({
    verifyEmailImpl: verifier,
    findEmailImpl: stantonHunter('UNKNOWN', 95),
  }));
  assert.equal(result.candidates_verified[0].verification_status, 'UNKNOWN');
  assert.equal(result.candidates_verified[0].verification_provider, 'HUNTER_VERIFIER');
  // #2 is only verified because #1 failed.
  assert.deepEqual(verifier.calls, ['brad@stantonhockett.co.uk', 'terry@stantonhockett.co.uk']);
  assert.equal(result.selected_contact.email, 'terry@stantonhockett.co.uk');
});

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
      verifyEmailImpl: verifier, findEmailImpl: stantonHunter(status),
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
  const hunter = stantonHunter('UNKNOWN', 62);
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
  // UNKNOWN did NOT stop the waterfall: every candidate was tried in order,
  // and exactly at the three-call cap.
  assert.deepEqual(verifier.calls, [
    'brad@stantonhockett.co.uk', 'terry@stantonhockett.co.uk', 'hello@stantonhockett.co.uk',
  ]);
  assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 3);
  assert.equal(result.selected_contact.email, 'hello@stantonhockett.co.uk');
  assert.equal(result.contact_resolution_status, 'RESOLVED_GENERIC');
});

await test('the Accept All threshold is the explicit fixed score-80 boundary', async () => {
  assert.equal(HUNTER_HIGH_CONFIDENCE_SCORE, 80);

  const runAtScore = async (score) => {
    const { store, valuesApi } = makeFakeSheet();
    const repo = createRepo(valuesApi);
    seedStantonHockett(store);
    return resolveAgencyContact(repo, 'ag_sh', baseOptions({
      verifyEmailImpl: makeVerifier({
        // The verifier says accept-all; Finder's score is what decides whether
        // that accept-all is selectable for this senior direct contact.
        'brad@stantonhockett.co.uk': 'RISKY',
        'terry@stantonhockett.co.uk': 'UNKNOWN',
        'hello@stantonhockett.co.uk': 'UNKNOWN',
      }),
      findEmailImpl: stantonHunter('RISKY', score),
    }));
  };

  // Exactly at the threshold qualifies; one below does not.
  assert.equal((await runAtScore(80)).selected_contact?.email, 'brad@stantonhockett.co.uk');
  assert.equal((await runAtScore(79)).selected_contact, null);
  // A missing score is never high confidence.
  assert.equal((await runAtScore(null)).selected_contact, null);
  assert.equal((await runAtScore(80)).hunter.high_confidence_threshold, 80);
});

await test('a high-score senior director Accept All hit may be selected as RISKY', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_dir', agency_name: 'Partner Estates', domain: 'partnerestates.co.uk',
    primary_contact_email: 'hello@partnerestates.co.uk',
  });
  const verifier = makeVerifier({
    'dana.reeve@partnerestates.co.uk': 'RISKY',
    'hello@partnerestates.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_dir', baseOptions({
    verifyEmailImpl: verifier,
    findDomainDecisionMakersImpl: makeDomainSearch([{
      full_name: 'Dana Reeve', position: 'Director', email: 'dana.reeve@partnerestates.co.uk',
      confidence: 98, decision_maker: true, verification_status: 'RISKY',
    }]),
  }));

  assert.equal(result.hunter.high_confidence, true, 'the score itself is high');
  assert.equal(result.hunter.caution_rule_applies, true, 'a Hunter-identified director is clearly senior');
  assert.equal(result.selected_contact.email, 'dana.reeve@partnerestates.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  // Verified explicitly before selection, and the generic inbox below it is not.
  assert.deepEqual(verifier.calls, ['dana.reeve@partnerestates.co.uk']);
});

await test('a cached inconclusive result selects a high-confidence owner with no new call', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedStantonHockett(store);
  seedContact(store, {
    contact_id: 'cnt_cached', agency_id: 'ag_sh', email: 'brad@stantonhockett.co.uk',
    contact_name: 'Bradley Stanton', email_source: 'HUNTER', contact_type: 'DIRECT',
    verification_status: 'RISKY', verified_at: '2026-08-20T09:00:00.000Z',
    notes: verifierProofNote('RISKY', '2026-08-20T09:00:00.000Z'),
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

// ── AGENCIES writeback reconciles a standing CONTACTS selection ─────────────
//
// REGRESSION (ag_hist_stantonhockett): CONTACTS held the selected Bradley
// Stanton row from an earlier run, but AGENCIES stayed blank. CONTACTS was not
// a discovery source, so on a rerun the Hunter-found brad@ address was not
// even a candidate — it is not derivable from AGENCIES or COMMUNICATIONS —
// so the run found no winner and wrote blanks over the agency's four outreach
// columns.
await test('a standing CONTACTS selection is reconciled into AGENCIES on rerun', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_hist_stantonhockett', agency_name: 'Stanton Hockett',
    domain: 'stantonhockett.co.uk', probe_sent: 'YES',
    owner_md: 'Bradley Stanton', primary_contact_email: 'hello@stantonhockett.co.uk',
    // The four outreach columns start blank — the reported symptom.
    outreach_contact_name: '', outreach_contact_email: '',
    email_verification_status: '', contact_resolution_status: '',
  });
  seedContact(store, {
    contact_id: 'cnt_brad', agency_id: 'ag_hist_stantonhockett',
    contact_name: 'Bradley Stanton', contact_role: 'Managing Director',
    email: 'brad@stantonhockett.co.uk', email_source: 'HUNTER', contact_type: 'DIRECT',
    verification_status: 'UNKNOWN', verified_at: '2026-08-25T09:00:00.000Z',
    // A genuine verifier result, so the standing decision is reconciled, not
    // re-litigated.
    notes: verifierProofNote('UNKNOWN', '2026-08-25T09:00:00.000Z'),
    is_selected_for_outreach: 'TRUE', created_at: '2026-08-25T09:00:00.000Z',
  });

  const verifier = makeVerifier({});
  const hunter = makeHunter(null);
  const result = await resolveAgencyContact(repo, 'ag_hist_stantonhockett', baseOptions({
    verifyEmailImpl: verifier,
    findEmailImpl: hunter,
    // A plain rerun: Hunter is not consulted again, so brad@ can ONLY come
    // back from CONTACTS.
    hunterConfigured: () => false,
  }));

  assert.ok(
    result.candidates_considered.some((c) => c.email === 'brad@stantonhockett.co.uk'),
    'the stored contact must be rediscovered from CONTACTS',
  );
  assert.equal(result.selected_contact.email, 'brad@stantonhockett.co.uk');
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.equal(hunter.calls.length, 0);
  assert.equal(verifier.calls.length, 0, 'reconciling a standing decision spends no credit');
  assert.equal(result.hunter_verifier.calls_made, 0);
  assert.equal(result.candidates_verified[0].reconciled, true);

  // The four AGENCIES columns, exactly as expected.
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.outreach_contact_name, 'Bradley Stanton');
  assert.equal(agency.outreach_contact_email, 'brad@stantonhockett.co.uk');
  assert.equal(agency.email_verification_status, 'UNKNOWN');
  assert.equal(agency.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.deepEqual(result.agency_writeback_missing_columns, []);

  // No duplicate rows, and the stored provenance survives the rerun.
  const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  assert.equal(contacts.filter((c) => c.email === 'brad@stantonhockett.co.uk').length, 1);
  const brad = contacts.find((c) => c.email === 'brad@stantonhockett.co.uk');
  assert.equal(brad.contact_id, 'cnt_brad', 'the existing row is updated, never replaced');
  assert.equal(brad.email_source, 'HUNTER', 'original provenance is not rewritten');
  assert.equal(brad.verification_status, 'UNKNOWN', 'the real status is preserved, not upgraded');
  assert.equal(brad.is_selected_for_outreach, 'TRUE');
});

await test('reconciling twice more stays stable and adds no rows or credits', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_rr', agency_name: 'Rerun Estates', domain: 'rerun.co.uk',
    owner_md: 'Bradley Stanton', primary_contact_email: 'hello@rerun.co.uk',
  });
  seedContact(store, {
    contact_id: 'cnt_rr', agency_id: 'ag_rr', contact_name: 'Bradley Stanton',
    contact_role: 'Managing Director', email: 'brad@rerun.co.uk', email_source: 'HUNTER',
    contact_type: 'DIRECT', verification_status: 'RISKY', verified_at: '2026-08-25T09:00:00.000Z',
    notes: verifierProofNote('RISKY', '2026-08-25T09:00:00.000Z'),
    is_selected_for_outreach: 'TRUE', created_at: '2026-08-25T09:00:00.000Z',
  });
  const verifier = makeVerifier({});
  const run = () => resolveAgencyContact(repo, 'ag_rr', baseOptions({
    verifyEmailImpl: verifier, hunterConfigured: () => false,
  }));
  await run(); await run(); await run();

  assert.equal(verifier.calls.length, 0);
  const contacts = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER);
  assert.equal(contacts.length, 2, 'brad@ plus the generic inbox, once each');
  assert.equal(contacts.filter((c) => c.is_selected_for_outreach === 'TRUE').length, 1);
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.email_verification_status, 'RISKY');
  assert.equal(agency.contact_resolution_status, 'RESOLVED_DIRECT');
});

await test('a stale standing selection is reconciled without re-verifying', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_stale', agency_name: 'Stale Estates', domain: 'stale.co.uk',
    owner_md: 'Bradley Stanton',
  });
  seedContact(store, {
    contact_id: 'cnt_stale', agency_id: 'ag_stale', contact_name: 'Bradley Stanton',
    contact_role: 'Managing Director', email: 'brad@stale.co.uk', email_source: 'HUNTER',
    contact_type: 'DIRECT', verification_status: 'UNKNOWN',
    // Well outside the 30-day verification cache TTL, but a genuine verifier
    // result all the same.
    verified_at: '2025-01-01T00:00:00.000Z',
    notes: verifierProofNote('UNKNOWN', '2025-01-01T00:00:00.000Z'),
    is_selected_for_outreach: 'TRUE', created_at: '2025-01-01T00:00:00.000Z',
  });
  const verifier = makeVerifier({});
  const result = await resolveAgencyContact(repo, 'ag_stale', baseOptions({
    verifyEmailImpl: verifier, hunterConfigured: () => false,
  }));
  assert.equal(verifier.calls.length, 0, 'a standing decision is reconciled, not re-decided');
  assert.equal(result.selected_contact.email, 'brad@stale.co.uk');
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
});

await test('a standing selection never overrides a hard fail or a better contact', async () => {
  // A stored INVALID is not a selection worth reconciling.
  const hardFail = makeFakeSheet();
  const hardFailRepo = createRepo(hardFail.valuesApi);
  seedAgency(hardFail.store, {
    agency_id: 'ag_hf', agency_name: 'Hard Fail', domain: 'hardfail.co.uk',
    owner_md: 'Bradley Stanton', primary_contact_email: 'hello@hardfail.co.uk',
  });
  seedContact(hardFail.store, {
    contact_id: 'cnt_hf', agency_id: 'ag_hf', contact_name: 'Bradley Stanton',
    email: 'brad@hardfail.co.uk', email_source: 'HUNTER', contact_type: 'DIRECT',
    verification_status: 'INVALID', verified_at: '2026-08-25T09:00:00.000Z',
    is_selected_for_outreach: 'TRUE', created_at: '2026-08-25T09:00:00.000Z',
  });
  const hfResult = await resolveAgencyContact(hardFailRepo, 'ag_hf', baseOptions({
    verifyEmailImpl: makeVerifier({ 'hello@hardfail.co.uk': 'VALID' }),
    hunterConfigured: () => false,
  }));
  assert.equal(hfResult.selected_contact.email, 'hello@hardfail.co.uk');
  assert.equal(hfResult.contact_resolution_status, 'RESOLVED_GENERIC');
  const hfBrad = rowsAsObjects(hardFail.store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === 'brad@hardfail.co.uk');
  assert.equal(hfBrad.is_selected_for_outreach, 'FALSE', 'an INVALID incumbent is stood down');

  // A standing GENERIC selection must not block a better owner contact found
  // since — higher priority still goes first.
  const upgrade = makeFakeSheet();
  const upgradeRepo = createRepo(upgrade.valuesApi);
  seedAgency(upgrade.store, {
    agency_id: 'ag_up', agency_name: 'Upgrade Estates', domain: 'upgrade.co.uk',
    owner_md: 'Nina Upgrade', primary_contact_email: 'hello@upgrade.co.uk',
  });
  seedContact(upgrade.store, {
    contact_id: 'cnt_up', agency_id: 'ag_up', email: 'hello@upgrade.co.uk',
    email_source: 'AGENCIES.primary_contact_email', contact_type: 'GENERIC',
    verification_status: 'RISKY', verified_at: '2026-08-25T09:00:00.000Z',
    is_selected_for_outreach: 'TRUE', created_at: '2026-08-25T09:00:00.000Z',
  });
  const upResult = await resolveAgencyContact(upgradeRepo, 'ag_up', baseOptions({
    verifyEmailImpl: makeVerifier({ 'nina.upgrade@upgrade.co.uk': 'VALID' }),
    findEmailImpl: makeHunter({ email: 'nina.upgrade@upgrade.co.uk', score: 96 }),
  }));
  assert.equal(upResult.selected_contact.email, 'nina.upgrade@upgrade.co.uk');
  assert.equal(upResult.selected_contact.verification_status, 'VALID');
  const upGeneric = rowsAsObjects(upgrade.store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === 'hello@upgrade.co.uk');
  assert.equal(upGeneric.is_selected_for_outreach, 'FALSE');
});

// ── Hunter Email Verifier discipline ───────────────────────────────────────
//
// The reported bug: contacts getting VALID/RISKY/UNKNOWN with no real Email
// Verifier call behind them. These four tests pin the fixed contract.

await test('the best candidate is verified explicitly before it can be selected', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_seq1', agency_name: 'Sequence Estates', domain: 'sequence.co.uk', probe_sent: 'YES',
    owner_md: 'Owen Sequence', primary_contact_email: 'owen.sequence@sequence.co.uk',
    other_known_emails: 'second@sequence.co.uk, info@sequence.co.uk',
  });
  const verifier = makeVerifier({ 'owen.sequence@sequence.co.uk': 'VALID' });
  const result = await resolveAgencyContact(repo, 'ag_seq1', baseOptions({ verifyEmailImpl: verifier }));

  // VALID on #1 -> select and stop. #2 and #3 are never verified.
  assert.deepEqual(verifier.calls, ['owen.sequence@sequence.co.uk']);
  assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 1);
  assert.deepEqual(result.hunter_verifier.emails_verified, ['owen.sequence@sequence.co.uk']);
  assert.deepEqual(result.hunter_verifier.verifier_results, [{
    email: 'owen.sequence@sequence.co.uk',
    verification_status: 'VALID',
    verification_score: null,
    provider: 'HUNTER_VERIFIER',
    hunter_verifier_called: true,
    verifier_proof: true,
    error: undefined,
  }]);
  assert.equal(result.selected_contact.email, 'owen.sequence@sequence.co.uk');
  assert.equal(result.selected_contact.verification_status, 'VALID');
});

await test('candidate #2 is verified only after #1 fails, #3 only after #2 fails', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_seq2', agency_name: 'Ladder Estates', domain: 'ladder.co.uk', probe_sent: 'YES',
    owner_md: 'Ola Ladder', primary_contact_email: 'ola.ladder@ladder.co.uk',
    other_known_emails: 'second@ladder.co.uk, info@ladder.co.uk',
  });
  const verifier = makeVerifier({
    'ola.ladder@ladder.co.uk': 'INVALID',      // #1 rejected
    'second@ladder.co.uk': 'DISPOSABLE',       // #2 rejected
    'info@ladder.co.uk': 'VALID',              // #3 wins
  });
  const result = await resolveAgencyContact(repo, 'ag_seq2', baseOptions({ verifyEmailImpl: verifier }));

  assert.deepEqual(verifier.calls, [
    'ola.ladder@ladder.co.uk', 'second@ladder.co.uk', 'info@ladder.co.uk',
  ]);
  assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 3);
  assert.equal(result.hunter_verifier.cap_reached, true);
  assert.equal(result.selected_contact.email, 'info@ladder.co.uk');
});

await test('no more than three Hunter verifier calls are ever spent on one agency', async () => {
  assert.equal(MAX_HUNTER_VERIFIER_CALLS_PER_AGENCY, 3);
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_cap', agency_name: 'Cap Estates', domain: 'cap.co.uk', probe_sent: 'YES',
    owner_md: 'Cara Cap', primary_contact_email: 'cara.cap@cap.co.uk',
    other_known_emails: 'a@cap.co.uk, b@cap.co.uk, c@cap.co.uk, d@cap.co.uk, info@cap.co.uk',
  });
  // Every address fails, so the waterfall would run to the end if uncapped.
  const verifier = makeVerifier({}, { defaultStatus: 'INVALID' });
  const result = await resolveAgencyContact(repo, 'ag_cap', baseOptions({ verifyEmailImpl: verifier }));

  assert.equal(verifier.calls.length, 3, 'the hard cap holds');
  assert.equal(result.hunter_verifier.hunter_verifier_calls_made, 3);
  assert.equal(result.hunter_verifier.max_calls_per_agency, 3);
  assert.equal(result.hunter_verifier.cap_reached, true);
  assert.ok(result.hunter_verifier.not_verified_cap_reached.length > 0);
  assert.equal(result.selected_contact, null);

  // Candidates past the cap are recorded as unverified, and their stored rows
  // carry neither an invented status nor verifier proof.
  const capped = result.candidates_verified.filter((v) => v.verification_provider === 'NOT_VERIFIED_CAP_REACHED');
  assert.ok(capped.length > 0);
  assert.ok(capped.every((v) => v.hunter_verifier_called === false && v.verifier_proof === false));
  const cappedRow = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === capped[0].email);
  assert.equal(cappedRow.verification_status, '', 'nothing was checked, so nothing is claimed');
  assert.ok(!/hunter_verifier:/.test(cappedRow.notes));
});

await test('Hunter Finder metadata is never treated as verification', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_finder', agency_name: 'Finder Estates', domain: 'finder.co.uk', probe_sent: 'YES',
    owner_md: 'Fay Finder', primary_contact_email: 'info@finder.co.uk',
  });
  // Finder says VALID; the verifier says INVALID. The verifier decides.
  const verifier = makeVerifier({
    'fay.finder@finder.co.uk': 'INVALID',
    'info@finder.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_finder', baseOptions({
    verifyEmailImpl: verifier,
    findEmailImpl: makeHunter({ email: 'fay.finder@finder.co.uk', score: 99, verification_status: 'VALID' }),
  }));

  assert.deepEqual(verifier.calls, ['fay.finder@finder.co.uk', 'info@finder.co.uk']);
  assert.equal(result.candidates_verified[0].verification_provider, 'HUNTER_VERIFIER');
  assert.equal(result.candidates_verified[0].verification_status, 'INVALID');
  assert.equal(result.selected_contact.email, 'info@finder.co.uk');
  // The Finder hit is stored with the verifier's verdict, plus proof of it.
  const finderRow = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === 'fay.finder@finder.co.uk');
  assert.equal(finderRow.verification_status, 'INVALID');
  assert.match(finderRow.notes, /\[hunter_verifier:INVALID@/);
});

await test('a verifier error is not proof, so the address is re-verified next run', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_err', agency_name: 'Error Estates', domain: 'errorestates.co.uk', probe_sent: 'YES',
    owner_md: 'Eli Error', primary_contact_email: 'eli.error@errorestates.co.uk',
  });
  const failing = makeVerifier({ 'eli.error@errorestates.co.uk': new Error('Hunter email verifier timed out') });
  const first = await resolveAgencyContact(repo, 'ag_err', baseOptions({ verifyEmailImpl: failing }));
  assert.equal(first.candidates_verified[0].verification_status, 'UNKNOWN');
  assert.equal(first.candidates_verified[0].verifier_proof, false);
  const row = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === 'eli.error@errorestates.co.uk');
  assert.ok(!/hunter_verifier:/.test(row.notes));

  const retry = makeVerifier({ 'eli.error@errorestates.co.uk': 'VALID' });
  const second = await resolveAgencyContact(repo, 'ag_err', baseOptions({ verifyEmailImpl: retry }));
  assert.deepEqual(retry.calls, ['eli.error@errorestates.co.uk']);
  assert.equal(second.selected_contact.verification_status, 'VALID');
});

await test('past the cap, an unproven standing selection is reconciled, not blanked', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_cap_rec', agency_name: 'Cap Reconcile', domain: 'capreconcile.co.uk', probe_sent: 'YES',
    owner_md: 'Casey Reconcile',
    primary_contact_email: 'a@capreconcile.co.uk',
    other_known_emails: 'b@capreconcile.co.uk, c@capreconcile.co.uk',
  });
  // The standing selection is the generic fallback tier, so it sits below the
  // three failing direct candidates and the cap is spent before it is reached.
  seedContact(store, {
    contact_id: 'cnt_cap_rec', agency_id: 'ag_cap_rec', email: 'info@capreconcile.co.uk',
    email_source: 'AGENCIES.other_known_emails', contact_type: 'GENERIC',
    verification_status: 'RISKY', verified_at: '2026-08-25T09:00:00.000Z',
    is_selected_for_outreach: 'TRUE', created_at: '2026-08-25T09:00:00.000Z',
  });
  const verifier = makeVerifier({}, { defaultStatus: 'INVALID' });
  const result = await resolveAgencyContact(repo, 'ag_cap_rec', baseOptions({
    verifyEmailImpl: verifier, hunterConfigured: () => false,
  }));

  assert.equal(verifier.calls.length, 3, 'the cap still holds');
  assert.equal(result.selected_contact.email, 'info@capreconcile.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  const capped = result.candidates_verified.find((v) => v.email === 'info@capreconcile.co.uk');
  assert.equal(capped.verification_provider, 'NOT_VERIFIED_CAP_REACHED');
  assert.equal(capped.verifier_proof, false, 'nothing was verified, so nothing is proven');

  // AGENCIES and CONTACTS agree, and the row stays unproven for the next run.
  const agency = rowsAsObjects(store, 'AGENCIES', AGENCIES_HEADER)[0];
  assert.equal(agency.outreach_contact_email, 'info@capreconcile.co.uk');
  assert.equal(agency.email_verification_status, 'RISKY');
  const row = rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER)
    .find((c) => c.email === 'info@capreconcile.co.uk');
  assert.equal(row.verification_status, 'RISKY');
  assert.ok(!/hunter_verifier:/.test(row.notes));
});

// ── Commercial-seniority ranking policy ─────────────────────────────────────
//
// Final winner selection: 1. VALID owner/senior direct, 2. RISKY owner/senior
// direct, 3. VALID named/probe-responder, 4. RISKY named/probe-responder,
// 5. VALID generic, 6. RISKY generic. Reported examples below.

await test('Ashton White: a senior direct RISKY contact beats a generic RISKY inbox', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_ashton', agency_name: 'Ashton White', domain: 'ashtonwhite.co.uk', probe_sent: 'YES',
    primary_contact_email: 'admin@ashtonwhite.co.uk',
  });
  // Chris White, Sales Director, responded to the probe — a senior direct
  // contact discovered from COMMUNICATIONS, not Hunter Finder.
  seedCommunication(store, {
    communication_id: 'com_ashton', agency_id: 'ag_ashton', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'chris.white@ashtonwhite.co.uk', display_name: 'Chris White, Sales Director',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const verifier = makeVerifier({
    'chris.white@ashtonwhite.co.uk': 'RISKY',
    'admin@ashtonwhite.co.uk': 'RISKY',
  });
  const result = await resolveAgencyContact(repo, 'ag_ashton', baseOptions({ verifyEmailImpl: verifier }));

  // Chris White is verified first (senior direct outranks generic in the
  // existing priority order) and wins outright — admin@ is never checked.
  assert.deepEqual(verifier.calls, ['chris.white@ashtonwhite.co.uk']);
  assert.equal(result.selected_contact.email, 'chris.white@ashtonwhite.co.uk');
  assert.equal(result.selected_contact.contact_name, 'Chris White, Sales Director');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  assert.equal(result.contact_resolution_status, 'RESOLVED_DIRECT');
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('admin@ashtonwhite.co.uk'));
});

await test('Carter Remy: a strong senior direct RISKY contact beats a VALID junior/generic contact', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_carter', agency_name: 'Carter Remy', domain: 'carterremy.co.uk', probe_sent: 'YES',
    owner_md: 'Carter Remy', primary_contact_email: 'info@carterremy.co.uk',
  });
  // A junior/unattributed contact responded too, and would verify VALID —
  // but the strong (score >= 80) senior owner match found by Hunter still
  // wins, because it is verified first in priority order.
  seedCommunication(store, {
    communication_id: 'com_carter', agency_id: 'ag_carter', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'junior@carterremy.co.uk', display_name: 'Junior Assistant',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const verifier = makeVerifier({
    'carter.remy@carterremy.co.uk': 'RISKY',
    'junior@carterremy.co.uk': 'VALID',
  });
  const hunter = makeHunter({ email: 'carter.remy@carterremy.co.uk', score: 92, position: 'Managing Director' });
  const result = await resolveAgencyContact(repo, 'ag_carter', baseOptions({
    verifyEmailImpl: verifier, findEmailImpl: hunter,
  }));

  assert.deepEqual(verifier.calls, ['carter.remy@carterremy.co.uk']);
  assert.equal(result.selected_contact.email, 'carter.remy@carterremy.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  assert.equal(result.selected_contact.selected_on_caution, true);
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('junior@carterremy.co.uk'));

  // ...but a WEAK senior attribution (score below threshold) does NOT beat a
  // VALID lower-priority contact: the waterfall moves on and the junior wins.
  const { store: weakStore, valuesApi: weakValuesApi } = makeFakeSheet();
  const weakRepo = createRepo(weakValuesApi);
  seedAgency(weakStore, {
    agency_id: 'ag_carter_weak', agency_name: 'Carter Remy Weak', domain: 'weak.carterremy.co.uk', probe_sent: 'YES',
    owner_md: 'Carter Remy', primary_contact_email: 'info@weak.carterremy.co.uk',
  });
  seedCommunication(weakStore, {
    communication_id: 'com_carter_weak', agency_id: 'ag_carter_weak', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'junior@weak.carterremy.co.uk', display_name: 'Junior Assistant',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const weakVerifier = makeVerifier({
    'carter.remy@weak.carterremy.co.uk': 'RISKY',
    'junior@weak.carterremy.co.uk': 'VALID',
  });
  const weakHunter = makeHunter({ email: 'carter.remy@weak.carterremy.co.uk', score: 55, position: 'Managing Director' });
  const weakResult = await resolveAgencyContact(weakRepo, 'ag_carter_weak', baseOptions({
    verifyEmailImpl: weakVerifier, findEmailImpl: weakHunter,
  }));
  assert.deepEqual(weakVerifier.calls, [
    'carter.remy@weak.carterremy.co.uk', 'junior@weak.carterremy.co.uk',
  ]);
  assert.equal(weakResult.selected_contact.email, 'junior@weak.carterremy.co.uk');
  assert.equal(weakResult.selected_contact.verification_status, 'VALID');
});

await test('VALID always wins outright, before any RISKY tier is even considered', async () => {
  // Sanity check on the tier table's own ordering: tier 3 (VALID named human)
  // is reached and selected before tier 4/5/6 are ever considered, because
  // VALID always selects immediately regardless of tier.
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_tier3', agency_name: 'Tier Three Homes', domain: 'tierthree.co.uk', probe_sent: 'YES',
    primary_contact_email: 'info@tierthree.co.uk',
  });
  seedCommunication(store, {
    communication_id: 'com_tier3', agency_id: 'ag_tier3', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'nadia@tierthree.co.uk', display_name: 'Nadia Kelly',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const verifier = makeVerifier({
    'nadia@tierthree.co.uk': 'VALID',
    'info@tierthree.co.uk': 'RISKY',
  });
  const result = await resolveAgencyContact(repo, 'ag_tier3', baseOptions({ verifyEmailImpl: verifier }));
  assert.deepEqual(verifier.calls, ['nadia@tierthree.co.uk']);
  assert.equal(result.selected_contact.email, 'nadia@tierthree.co.uk');
  assert.equal(result.selected_contact.verification_status, 'VALID');
});

await test('a RISKY named human / probe responder beats a VALID generic inbox (tier 4 over tier 5)', async () => {
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_tier4', agency_name: 'Tier Four Homes', domain: 'tierfour.co.uk', probe_sent: 'YES',
    primary_contact_email: 'info@tierfour.co.uk',
  });
  // No senior-role wording and no owner match, so this is priority NAMED_HUMAN
  // rather than SENIOR_DIRECT/BRANCH_MANAGER — still outranks generic.
  seedCommunication(store, {
    communication_id: 'com_tier4', agency_id: 'ag_tier4', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'priya@tierfour.co.uk', display_name: 'Priya Shah',
    automated_or_human: 'human', occurred_at: '2026-08-02T09:00:00.000Z',
  });
  const verifier = makeVerifier({
    'priya@tierfour.co.uk': 'RISKY',
    'info@tierfour.co.uk': 'VALID',
  });
  const result = await resolveAgencyContact(repo, 'ag_tier4', baseOptions({ verifyEmailImpl: verifier }));
  assert.deepEqual(verifier.calls, ['priya@tierfour.co.uk']);
  assert.equal(result.selected_contact.email, 'priya@tierfour.co.uk');
  assert.equal(result.selected_contact.verification_status, 'RISKY');
  assert.ok(result.hunter_verifier.not_verified_after_winner.includes('info@tierfour.co.uk'));
});

await test('writeback survives header drift and reports genuinely missing columns', () => {
  const header = ['agency_id', 'Outreach Contact Name ', 'outreach_contact_email', 'AGENCY_NAME'];
  assert.equal(resolveHeaderName(header, 'outreach_contact_name'), 'Outreach Contact Name ');
  assert.equal(resolveHeaderName(header, 'outreach_contact_email'), 'outreach_contact_email');
  assert.equal(resolveHeaderName(header, 'agency_name'), 'AGENCY_NAME');
  assert.equal(resolveHeaderName(header, 'contact_resolution_status'), null);
});

await test('a missing outreach column is reported, not swallowed', async () => {
  // A workbook whose AGENCIES tab never got the four outreach columns.
  const store = {
    AGENCIES: [
      ['agency_id', 'agency_name', 'domain', 'owner_md', 'primary_contact_email', 'notes', 'updated_at'],
      ['SCHEMA NOTE', 'Stable identity only.'],
      ['ag_nocols', 'No Columns', 'nocols.co.uk', '', 'hello@nocols.co.uk', '', ''],
    ],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), ['SCHEMA NOTE', '']],
    CONTACTS: [CONTACTS_HEADER.slice(), ['SCHEMA NOTE', '']],
  };
  const { valuesApi } = makeFakeSheet();
  const backing = makeFakeSheet();
  backing.store.AGENCIES = store.AGENCIES;
  const result = await resolveAgencyContact(createRepo(backing.valuesApi), 'ag_nocols', baseOptions({
    verifyEmailImpl: makeVerifier({ 'hello@nocols.co.uk': 'VALID' }),
  }));
  assert.equal(result.selected_contact.email, 'hello@nocols.co.uk');
  assert.deepEqual(
    result.agency_writeback_missing_columns.sort(),
    ['contact_resolution_status', 'email_verification_status', 'outreach_contact_email', 'outreach_contact_name'],
    'a workbook missing the columns must say so rather than look like a success',
  );
  assert.ok(valuesApi);
});

// ── Read quota: one request-scoped snapshot, no reads during processing ─────
await test('one agency resolution reads AGENCIES, COMMUNICATIONS and CONTACTS exactly once each', async () => {
  const { store, valuesApi, calls } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_reads', agency_name: 'Read Count Estates', domain: 'reads.co.uk',
    owner_md: 'Rita Reads', primary_contact_email: 'rita.reads@reads.co.uk',
    other_known_emails: 'info@reads.co.uk',
  });
  await resolveAgencyContact(repo, 'ag_reads', baseOptions({
    verifyEmailImpl: makeVerifier({ 'rita.reads@reads.co.uk': 'VALID' }),
  }));

  assert.equal(calls.get.length, 3, `expected 3 reads, got ${calls.get.length}: ${calls.get.join(', ')}`);
  assert.deepEqual([...calls.get].sort(), ['AGENCIES', 'COMMUNICATIONS', 'CONTACTS']);
  assert.equal(calls.append.length, 0, 'new CONTACTS rows are included in the prepared batch');
  assert.equal(calls.update.length, 0, 'AGENCIES cells are included in the prepared batch');
  assert.equal(calls.batchUpdate.length, 2, 'CONTACTS rows and AGENCIES cells are each written in one batch');
});

await test('processing many candidates does not trigger repeated sheet reads', async () => {
  const { store, valuesApi, calls } = makeFakeSheet();
  const repo = createRepo(valuesApi);
  seedAgency(store, {
    agency_id: 'ag_many', agency_name: 'Many Candidates', domain: 'many.co.uk',
    owner_md: 'Maya Many', primary_contact_email: 'maya.many@many.co.uk',
    other_known_emails: 'm.many@many.co.uk, team.member@many.co.uk, info@many.co.uk',
  });
  seedCommunication(store, {
    communication_id: 'com_many', agency_id: 'ag_many', channel: 'email', direction: 'inbound',
    source_identifier_normalized: 'reply.person@many.co.uk', display_name: 'Reply Person',
    automated_or_human: 'human',
  });
  const verifier = makeVerifier({ 'info@many.co.uk': 'VALID' }, { defaultStatus: 'INVALID' });
  const result = await resolveAgencyContact(repo, 'ag_many', baseOptions({ verifyEmailImpl: verifier }));

  assert.ok(result.candidates_verified.length >= 4, 'the waterfall must actually process several candidates');
  assert.equal(calls.get.length, 3, 'candidate count must not affect Sheets read count');
  assert.deepEqual([...new Set(calls.get)].sort(), ['AGENCIES', 'COMMUNICATIONS', 'CONTACTS']);
});

await test('Sheets 429 responses use two short backoff retries and then succeed', async () => {
  let fetchCalls = 0;
  const delays = [];
  const result = await fetchSheetsJson('https://sheets.googleapis.test/values/AGENCIES', {}, {
    getAccessTokenImpl: async () => 'test-token',
    sleepImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls < 3) {
        return {
          ok: false, status: 429,
          headers: { get: () => null },
          text: async () => 'RESOURCE_EXHAUSTED',
        };
      }
      return { ok: true, status: 200, json: async () => ({ values: [['ok']] }) };
    },
  });
  assert.deepEqual(result, { values: [['ok']] });
  assert.equal(fetchCalls, 3, 'one request plus at most two retries');
  assert.deepEqual(delays, [500, 1500], 'backoff is short, bounded and non-aggressive');
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
  assert.equal(backlog[0].sheet_row_number, 3, 'row 1 header + row 2 schema note means first data row is physical row 3');
  const all = await listResolutionBacklog(repo, { includeResolved: true });
  assert.deepEqual(all.map((a) => a.agency_id), ['ag_p1', 'ag_p2']);
  assert.deepEqual(all.map((a) => a.sheet_row_number), [3, 4]);
  // Nothing was written by listing.
  assert.equal(rowsAsObjects(store, 'CONTACTS', CONTACTS_HEADER).length, 0);
});

await test('NEEDS_RESEARCH recheck targets exact status only on physical rows after 180', () => {
  const rows = [
    { sheet_row_number: 179, agency_id: 'ag_179', contact_resolution_status: 'NEEDS_RESEARCH' },
    { sheet_row_number: 180, agency_id: 'ag_180', contact_resolution_status: 'NEEDS_RESEARCH' },
    { sheet_row_number: 181, agency_id: 'ag_181', contact_resolution_status: 'NEEDS_RESEARCH' },
    { sheet_row_number: 182, agency_id: 'ag_direct', contact_resolution_status: 'RESOLVED_DIRECT' },
    { sheet_row_number: 183, agency_id: 'ag_generic', contact_resolution_status: 'RESOLVED_GENERIC' },
    { sheet_row_number: 184, agency_id: 'ag_blank', contact_resolution_status: '' },
    { sheet_row_number: 185, agency_id: 'ag_other', contact_resolution_status: 'NO_VALID_EMAIL' },
  ];
  const partitioned = partitionNeedsResearch(rows);
  assert.deepEqual(partitioned.needsResearch.map((row) => row.agency_id), ['ag_179', 'ag_180', 'ag_181']);
  assert.deepEqual(partitioned.excluded.map((row) => row.agency_id), ['ag_179', 'ag_180']);
  assert.deepEqual(partitioned.eligible.map((row) => row.agency_id), ['ag_181']);
  assert.equal(isRecheckEligible(rows[1]), false, 'physical row 180 is excluded');
  assert.equal(isRecheckEligible(rows[2]), true, 'physical row 181 is eligible');
});

await test('NEEDS_RESEARCH runner accepts both --limit 5 and --limit=5', () => {
  assert.equal(parseRecheckArgs(['--limit', '5']).limit, '5');
  assert.equal(parseRecheckArgs(['--limit=5']).limit, '5');
});

await test('NEEDS_RESEARCH runner retries HTTP 429 with bounded exponential backoff', async () => {
  let calls = 0;
  const delays = [];
  const { response, result } = await recheckRequestJson('https://example.test', {}, {
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return { status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) };
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ ok: true }) };
    },
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

await test('NEEDS_RESEARCH runner rechecks physical row and status immediately before each resolve', async () => {
  const initial = [
    { sheet_row_number: 180, agency_id: 'ag_excluded', agency_name: 'Excluded', contact_resolution_status: 'NEEDS_RESEARCH' },
    { sheet_row_number: 181, agency_id: 'ag_moved', agency_name: 'Moved', contact_resolution_status: 'NEEDS_RESEARCH' },
    { sheet_row_number: 182, agency_id: 'ag_live', agency_name: 'Live', contact_resolution_status: 'NEEDS_RESEARCH' },
    { sheet_row_number: 183, agency_id: 'ag_blank', agency_name: 'Blank', contact_resolution_status: '' },
  ];
  let getCount = 0;
  const posted = [];
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const summary = await runNeedsResearchRecheck([
      '--confirm', RECHECK_CONFIRMATION, '--limit=2', '--throttle-ms=1', '--user=test', '--pass=test', '--base=https://example.test',
    ], {
      sleepImpl: async () => {},
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes('resolution-backlog')) {
          getCount += 1;
          const rows = getCount === 1
            ? initial
            : getCount === 2
              ? initial.map((row) => row.agency_id === 'ag_moved' ? { ...row, sheet_row_number: 180 } : row)
              : initial;
          return { ok: true, status: 200, json: async () => ({ agencies: rows }) };
        }
        posted.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ contact_resolution_status: 'RESOLVED_GENERIC', selected_contact: { email: 'info@example.test' } }) };
      },
    });
    assert.deepEqual(posted, [{ agency_id: 'ag_live', dry_run: false }]);
    assert.deepEqual(summary, { processed: 1, skipped_recheck: 1, failed: 0, targeted: 2, eligible_at_start: 2 });
    assert.ok(logs.includes('Total NEEDS_RESEARCH rows: 3'));
    assert.ok(logs.includes('Excluded at sheet row <= 180: 1'));
    assert.ok(logs.includes('Eligible at sheet row > 180: 2'));
    assert.ok(logs.some((line) => line.includes('row 181  ag_moved  Moved  NEEDS_RESEARCH')));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

// ── Hard provider boundary ──────────────────────────────────────────────────
await test('all resolver paths have no owner-research, Anthropic or web-search dependency', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolverSource = fs.readFileSync(path.join(root, 'lib/contact-resolution.mjs'), 'utf8');
  const hunterSource = fs.readFileSync(path.join(root, 'lib/hunter.mjs'), 'utf8');
  const executableSource = `${resolverSource}\n${hunterSource}`
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(executableSource, /owner-research|researchOwner|ai-client|Anthropic|Claude|web_search/i);
  assert.match(executableSource, /from ['"]\.\/hunter\.mjs['"]/);
});

// ── Serverless Function count must not increase ─────────────────────────────
await test('Vercel Serverless Function count stays at 12 or fewer', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  const realVerify = hunter.verifyEmail;
  const realFind = hunter.findEmail;
  const originalFetch = globalThis.fetch;
  process.env.HUNTER_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { status: 'valid', score: 100 } }),
  });

  const ok = mockRes();
  await handler({ method: 'POST', query: { novus_operation: 'resolve-contact' }, body: { agency_id: 'ag_api' }, headers: { authorization: authHeader } }, ok);
  assert.equal(ok.statusCode, 200);
  for (const key of ['agency', 'owner_md', 'candidates_considered', 'candidates_verified',
    'hunter_verifier', 'hunter', 'selected_contact', 'contact_resolution_status']) {
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
  assert.equal(hunter.verifyEmail, realVerify);
  assert.equal(hunter.findEmail, realFind);
});

console.log(`\n${passed} contact-resolution checks passed.`);
