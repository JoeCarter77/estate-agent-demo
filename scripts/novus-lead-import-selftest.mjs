// scripts/novus-lead-import-selftest.mjs — hermetic test for the lead-database
// reconciliation import (no network, no creds).
//
// Seeds an in-memory fake that mirrors the LIVE NOVUS_Data_V1_Master_v2
// workbook's actual current tab headers and rows (README, AGENCIES, PROBES,
// COMMUNICATIONS, INTELLIGENCE, ACTIONS — captured 2026-08-15), then runs the
// real importer code (scripts/import-lead-database.mjs's runImport) against
// it, exactly as production will.
//
// Run: node scripts/novus-lead-import-selftest.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRepo } from '../lib/sheets.mjs';
import { runImport, formatReport } from './import-lead-database.mjs';
import { assertRecordMatchesHeader } from '../lib/lead-import.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const INTELLIGENCE_HEADER = [
  'intelligence_id','agency_id','probe_id','observation_status','observation_deadline',
  'auto_acknowledgement','auto_ack_timestamp','crm_detected','crm_name','crm_evidence',
  'first_human_touch','first_human_touch_at','human_lag_hours','callback_attempts',
  'successful_conversations','voicemail_count','inbound_sms_count','email_touch_count',
  'follow_up_count','follow_up_channels','last_touch_at','days_chased','booking_attempt',
  'contact_quality','proactive_reactive','persistence_profile','channels_used','grade',
  'grade_reason','tier','tier_reason','sales_angle','segment','ai_evidence_summary','ai_confidence',
  'manual_override','override_reason','observation_closed_at','created_at','updated_at',
  'contact_attempt_count','observed_problem','commercial_implication','discovery_focus','demo_type',
  'email_strategy','phone_strategy','next_action',
];
const ACTIONS_HEADER = [
  'action_id','agency_id','probe_id','action_type','action_status','priority','due_at',
  'completed_at','owner','trigger','reason','related_communication_id','notes','created_at','updated_at',
];

const SYNTHETIC_AGENCY_ROW = [
  'ag_msstv7xg_bodbye','NOVUS TEST AGENCY — DO NOT OUTREACH','','','TEST FIXTURE — synthetic, not a real agency',
  '','447455506761','447455506761','NOVUS Test Contact','joedcarter1@gmail.com','','','','','','','','','',
  'TEST_DO_NOT_USE','test_only','suppressed',
  'Synthetic fixture for NOVUS Communications Layer E2E verification. Not a real agency — do not contact.',
  'SYNTHETIC TEST FIXTURE. Created 2026-08-14 to verify voice/SMS/email -> Communication Event -> matching -> Observation/Evidence pipeline end-to-end. Safe to delete once testing is complete.',
  '2026-08-14T10:52:13.924Z','2026-08-14T10:52:13.924Z',
];
const SYNTHETIC_PROBE_ROW = [
  'prb_msstv7xg_nksnc0','TEST-0001','ag_msstv7xg_bodbye','rightmove',
  '1 Synthetic Test Street, TESTFIXTURE, T3 5T1','https://example.com/novus-test-fixture-do-not-use',
  '','','SYNTHETIC — NOVUS E2E pipeline test enquiry, no real agency contacted.','novusprobes@gmail.com',
  '447575333064','2026-08-14T10:52:13.924Z','2026-08-21T10:52:13.924Z','observing','FALSE','','','',
  'SYNTHETIC TEST FIXTURE — paired with ag_msstv7xg_bodbye. Not a real probe.',
  '2026-08-14T10:52:13.924Z','2026-08-14T10:52:13.924Z',
];
// One representative real COMMUNICATIONS row already matched to the synthetic
// probe (mirrors the live sheet) — used to prove the importer never touches it.
const SAMPLE_COMMUNICATION_ROW = [
  'com_mssu74ss_l4p0yh','ag_msstv7xg_bodbye','prb_msstv7xg_nksnc0','CAe3384b220f422c3a726f353605f63aa4',
  '2026-08-14T11:01:28.851Z','2026-08-14T11:01:28.851Z','voice','inbound','call','twilio',
  'CAe3384b220f422c3a726f353605f63aa4','+447455506761','+447455506761','+447575333064','','voicemail','6',
  'TRUE','https://api.twilio.com/x','It.','','','','','','rev_mssu7443_tjzxr4','phone_exact','1','matched',
  'human','TRUE','TRUE','FALSE','FALSE','FALSE','','','','','','','not_required','','',
  '2026-08-14T11:01:28.851Z','2026-08-14T11:02:22.718Z',
];
const SAMPLE_INTELLIGENCE_ROW = [
  'itl_mssv5947_ztaryv','ag_msstv7xg_bodbye','prb_msstv7xg_nksnc0','observing','2026-08-21T10:52:13.924Z',
  'FALSE','','unknown','','','yes','2026-08-14T11:01:28.851Z','0.1541463889','1','0','1','','','1','sms',
  '2026-08-14T12:42:33.777Z','0.08','TRUE','Booking attempt','','multi-channel','voice,sms','A',
  'Very fast human contact (≤1h) with 1+ genuine follow-up attempt(s).','','','','','','2026-08-14T11:28:01.471Z',
  '2026-08-14T12:42:36.769Z','','','','','','','',
];

function makeFakeSheet() {
  const store = {
    AGENCIES: [AGENCIES_HEADER.slice(), SYNTHETIC_AGENCY_ROW.slice(), ['SCHEMA NOTE', 'Stable identity only.']],
    PROBES: [PROBES_HEADER.slice(), SYNTHETIC_PROBE_ROW.slice(), ['SCHEMA NOTE', 'One row per actual probe.']],
    COMMUNICATIONS: [COMMUNICATIONS_HEADER.slice(), SAMPLE_COMMUNICATION_ROW.slice()],
    INTELLIGENCE: [INTELLIGENCE_HEADER.slice(), SAMPLE_INTELLIGENCE_ROW.slice()],
    ACTIONS: [ACTIONS_HEADER.slice()],
  };
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) { const m = String(range).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; }
  const valuesApi = {
    async get(range) { const tab = tabOf(range); return (store[tab] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const tab = tabOf(range); store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return { updates: { updatedRows: rows.length } };
    },
    async update(range, rows) {
      const tab = tabOf(range); const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => { store[tab][start - 1 + i] = r.slice(); });
      return { updatedRows: rows.length };
    },
  };
  return { store, valuesApi };
}

function loadRealSourceRows() {
  const csvPath = resolve(__dirname, '../data/lead-database-import/LEAD_DATABASE_1.csv');
  const raw = readFileSync(csvPath, 'utf8');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) { if (c === '"') { if (raw[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c; }
    else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* swallow */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const filtered = rows.filter((r) => r.some((v) => v !== ''));
  const header = filtered[0];
  return filtered.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

let passed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }

async function run() {
  const sourceRows = loadRealSourceRows();
  assert.strictEqual(sourceRows.length, 144, 'source CSV has 144 agency rows');
  ok('loaded 144 source agency rows from LEAD_DATABASE_1.csv');

  // ── Run 1: fresh sheet (only the synthetic fixture present) ──
  console.log('\nPart A — first import run');
  const { store, valuesApi } = makeFakeSheet();
  const repo = createRepo(valuesApi);

  const result1 = await runImport(repo, sourceRows, { apply: true });
  console.log(formatReport(result1));

  assert.strictEqual(result1.agencies.imported, 144, 'all 144 source agencies imported as new');
  ok('imported exactly 144 new agencies on a fresh sheet');

  assert.strictEqual(result1.agencies.alreadyExisting, 0);
  assert.strictEqual(result1.agencies.merged, 0);
  ok('0 already-existing / 0 merged on first run (nothing to match against yet)');

  assert.strictEqual(result1.agencies.ambiguousPhoneGroups.length, 1, 'the Gates Parish phone collision is flagged');
  assert.strictEqual(result1.agencies.ambiguousPhoneGroups[0].phone, '+441708250033');
  ok('flags the one genuinely ambiguous phone collision (2 different domains, same phone) without merging them');

  assert.strictEqual(result1.agencies.skipped.length, 0);
  ok('0 agencies skipped (every source row has a usable domain)');

  assert.strictEqual(result1.probes.discovered, 24, '24 historical probes discovered (non-blank Probe Sent)');
  assert.strictEqual(result1.probes.imported, 24, 'all 24 historical probes imported');
  assert.strictEqual(result1.probes.duplicatesAvoided, 0);
  ok('discovered 24 / imported 24 / avoided 0 duplicate historical probes on first run');

  // Identity checks against the actual written sheet rows.
  const agencyRecords = await repo.getRecords('AGENCIES', 'agency_id');
  const realAgencyRecords = agencyRecords.filter((r) => r.obj.agency_id !== 'ag_msstv7xg_bodbye');
  assert.strictEqual(realAgencyRecords.length, 144);
  const agencyIds = realAgencyRecords.map((r) => r.obj.agency_id);
  assert.strictEqual(new Set(agencyIds).size, 144, 'no duplicate agency_id values');
  assert.ok(agencyIds.every((id) => /^ag_/.test(id)), 'every agency_id uses the ag_ prefix');
  ok('144 unique, correctly-prefixed agency_id values written');

  const probeRecords = await repo.getRecords('PROBES', 'probe_id');
  const realProbeRecords = probeRecords.filter((r) => r.obj.probe_id !== 'prb_msstv7xg_nksnc0');
  assert.strictEqual(realProbeRecords.length, 24);
  const probeIds = realProbeRecords.map((r) => r.obj.probe_id);
  assert.strictEqual(new Set(probeIds).size, 24, 'no duplicate probe_id values');
  ok('24 unique probe_id values written');

  const agencyIdSet = new Set(agencyIds);
  assert.ok(realProbeRecords.every((r) => agencyIdSet.has(r.obj.agency_id)), 'every imported probe has a valid agency_id');
  ok('every imported probe links to a real, resolved agency_id');

  // Synthetic fixture untouched.
  const syntheticAgency = agencyRecords.find((r) => r.obj.agency_id === 'ag_msstv7xg_bodbye');
  assert.deepStrictEqual(store.AGENCIES[1], SYNTHETIC_AGENCY_ROW, 'synthetic AGENCIES row byte-for-byte unchanged');
  assert.strictEqual(syntheticAgency.obj.suppression_status, 'suppressed');
  ok('synthetic AGENCIES fixture left completely untouched (still suppressed, still isolated)');
  const syntheticProbeRow = store.PROBES.find((r) => r[0] === 'prb_msstv7xg_nksnc0');
  assert.deepStrictEqual(syntheticProbeRow, SYNTHETIC_PROBE_ROW, 'synthetic PROBES row byte-for-byte unchanged');
  ok('synthetic PROBES fixture left completely untouched');
  assert.ok(!realAgencyRecords.some((r) => r.obj.suppression_status === 'suppressed' && String(r.obj.notes).includes('SYNTHETIC')), 'no real agency accidentally tagged synthetic');
  ok('no real imported agency can be mistaken for the synthetic fixture');

  // Evidence rule: no COMMUNICATIONS / INTELLIGENCE / ACTIONS fabricated.
  assert.strictEqual(store.COMMUNICATIONS.length, 2, 'COMMUNICATIONS row count unchanged (header + 1 pre-existing row)');
  assert.strictEqual(store.INTELLIGENCE.length, 2, 'INTELLIGENCE row count unchanged (header + 1 pre-existing row)');
  assert.strictEqual(store.ACTIONS.length, 1, 'ACTIONS row count unchanged (header only)');
  ok('zero COMMUNICATIONS/INTELLIGENCE/ACTIONS rows fabricated from the lead database (evidence rule)');

  // Dirty-field handling: the "Uses CRM?" = "Street" row must not become an
  // authoritative crm_name/crm_evidence value anywhere, only a flagged note.
  const dirtyRow = sourceRows.find((r) => String(r['Uses CRM?']).trim().toLowerCase() === 'street');
  assert.ok(dirtyRow, 'fixture assumption: the dataset contains the known dirty "Uses CRM?"="Street" row');
  const dirtyAgency = realAgencyRecords.find((r) => r.obj.notes.includes(`slug=${dirtyRow.Slug}`));
  assert.strictEqual(dirtyAgency.obj.crm_name, '', 'dirty CRM field never becomes an authoritative crm_name');
  assert.strictEqual(dirtyAgency.obj.crm_evidence, '', 'dirty CRM field never becomes an authoritative crm_evidence');
  assert.ok(dirtyAgency.obj.notes.includes('MANUAL REVIEW'), 'dirty CRM value is flagged for manual review in notes');
  ok('dirty "Uses CRM?" source value is preserved as a flagged note, never promoted to crm_name/crm_evidence');

  // Grade/tier never fabricated on the historical probes.
  const historicalProbe = realProbeRecords[0];
  assert.strictEqual(historicalProbe.obj.probe_status, 'observing');
  assert.ok(historicalProbe.obj.probe_reference.startsWith('HIST-'), 'historical probes get a HIST- reference, distinct from live RM-#### sequence');
  ok('historical probes carry no fabricated grade/tier and use a distinct HIST- reference prefix');

  // ── Part B: idempotency — run the exact same import again ──
  console.log('\nPart B — second import run (idempotency)');
  const result2 = await runImport(repo, sourceRows, { apply: true });
  console.log(formatReport(result2));

  assert.strictEqual(result2.agencies.imported, 0, 'second run creates zero new agencies');
  assert.strictEqual(result2.agencies.alreadyExisting, 144, 'second run recognizes all 144 as already existing');
  ok('re-running the importer creates 0 duplicate agencies');

  assert.strictEqual(result2.probes.imported, 0, 'second run creates zero new probes');
  assert.strictEqual(result2.probes.duplicatesAvoided, 24, 'second run avoids all 24 as duplicates');
  ok('re-running the importer creates 0 duplicate probes');

  const agencyRecords2 = await repo.getRecords('AGENCIES', 'agency_id');
  const probeRecords2 = await repo.getRecords('PROBES', 'probe_id');
  assert.strictEqual(agencyRecords2.length, 145, 'AGENCIES row count unchanged after re-run (144 real + 1 synthetic)');
  assert.strictEqual(probeRecords2.length, 25, 'PROBES row count unchanged after re-run (24 real + 1 synthetic)');
  assert.deepStrictEqual(agencyRecords2.map((r) => r.obj.agency_id).sort(), agencyRecords.map((r) => r.obj.agency_id).sort(), 'agency_id set identical across re-run — stable, not regenerated');
  assert.deepStrictEqual(probeRecords2.map((r) => r.obj.probe_id).sort(), probeRecords.map((r) => r.obj.probe_id).sort(), 'probe_id set identical across re-run — stable, not regenerated');
  ok('agency_id and probe_id values are stable (not regenerated) across a re-run');

  assert.strictEqual(store.COMMUNICATIONS.length, 2, 'COMMUNICATIONS still untouched after re-run');
  assert.strictEqual(store.INTELLIGENCE.length, 2, 'INTELLIGENCE still untouched after re-run');
  ok('COMMUNICATIONS and INTELLIGENCE remain untouched across a re-run');

  // ── Part C: dry run makes zero writes ──
  console.log('\nPart C — dry run performs no writes');
  const { store: store3, valuesApi: valuesApi3 } = makeFakeSheet();
  const repo3 = createRepo(valuesApi3);
  const dryResult = await runImport(repo3, sourceRows, { apply: false });
  assert.strictEqual(dryResult.applied, false);
  assert.strictEqual(store3.AGENCIES.length, 3, 'AGENCIES untouched in dry-run mode (header + synthetic + SCHEMA NOTE)');
  assert.strictEqual(store3.PROBES.length, 3, 'PROBES untouched in dry-run mode');
  assert.strictEqual(dryResult.agencies.imported, 144, 'dry run still computes the full would-be reconciliation');
  ok('dry run computes the full report but performs zero writes');

  // ── Part D: schema validation guard ──
  console.log('\nPart D — schema validation guard');
  assert.throws(
    () => assertRecordMatchesHeader(AGENCIES_HEADER, { agency_id: 'x', totally_unknown_field: 'y' }, 'AGENCIES'),
    /unknown/i,
    'an unknown column throws instead of being silently dropped'
  );
  ok('assertRecordMatchesHeader rejects a record with a column absent from the live header');
  assert.doesNotThrow(() => assertRecordMatchesHeader(AGENCIES_HEADER, { agency_id: 'x', agency_name: 'y' }, 'AGENCIES'));
  ok('assertRecordMatchesHeader accepts a record whose columns are all present in the live header');

  console.log(`\n${passed} checks passed.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
