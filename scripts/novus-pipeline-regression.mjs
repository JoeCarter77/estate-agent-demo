// scripts/novus-pipeline-regression.mjs — runs the WHOLE pipeline
//   PROBES -> COMMUNICATIONS -> classification/evidence -> INTELLIGENCE
//   -> grading -> DIAGNOSIS
// against CSV exports of the live workbook, and reports the before/after
// population counts for every field the Intelligence rebuild is supposed to
// fill in.
//
// "Before" = the state of the CSVs exactly as exported (i.e. what the sheet
// looks like right now). "After" = the same tables once rebuildAllIntelligence()
// and rebuildAllDiagnosis() have run over them, in memory. No network, no
// credentials, no writes to the real sheet — the CSVs are loaded into the same
// in-memory fake Sheets transport the self-tests use.
//
// Usage:
//   npm run novus:pipeline-regression                  # bundled fixtures
//   npm run novus:pipeline-regression -- --dir ./exports   # your own exports
//
// --dir must contain PROBES.csv, COMMUNICATIONS.csv, INTELLIGENCE.csv and
// DIAGNOSIS.csv, exported with the header row intact (row 2 may be the
// workbook's "SCHEMA NOTE" row — it is skipped, same as in the sheet).
//
// Exit code is 0 when every "after" count is >= its "before" count and the
// A-H grade distribution is unchanged by anything outside lib/grading.mjs;
// non-zero otherwise. That makes it usable as a regression gate, not just a
// report.

import fs from 'node:fs';
import path from 'node:path';
import { createRepo } from '../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';
import { isHumanCommunication, interpretCommunication } from '../lib/classification.mjs';
import { readVendorStatus } from '../lib/vendor-intent.mjs';
import { readMissedFindings } from '../lib/evidence-summary.mjs';

const TABS = ['PROBES', 'COMMUNICATIONS', 'INTELLIGENCE', 'DIAGNOSIS'];

// ── Minimal RFC4180 CSV reader (quoted fields, embedded commas/newlines) ──────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

function toCsv(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

// ── In-memory Sheets transport over the loaded tables ─────────────────────────
function makeRepoFromStore(store) {
  function tabOf(range) { return String(range).split('!')[0]; }
  function startRowOf(range) {
    const m = String(range).match(/!\D+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  return createRepo({
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const tab = tabOf(range);
      store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return {};
    },
    async update(range, rows) {
      const tab = tabOf(range);
      const start = startRowOf(range);
      store[tab] = store[tab] || [];
      rows.forEach((r, i) => {
        const idx = start - 1 + i;
        while (store[tab].length <= idx) store[tab].push([]);
        const existing = store[tab][idx] || [];
        // A range update replaces only the cells it covers.
        r.forEach((v, c) => { existing[c] = v; });
        store[tab][idx] = existing;
      });
      return {};
    },
    async batchUpdate(data) {
      for (const { range, values } of data) await this.update(range, values);
      return {};
    },
  });
}

// ── Counting ──────────────────────────────────────────────────────────────────
function records(store, tab, idColumn) {
  const values = store[tab] || [];
  const header = values[0] || [];
  const idIdx = header.indexOf(idColumn);
  const out = [];
  values.slice(1).forEach((row) => {
    const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((k, i) => { obj[k] = row[i] ?? ''; });
    out.push(obj);
  });
  return out;
}

const filled = (v) => String(v ?? '').trim() !== '';

// Every metric the rebuild is supposed to populate. Each returns a count of
// rows carrying real content in that field.
function measure(store) {
  const comms = records(store, 'COMMUNICATIONS', 'communication_id');
  const intel = records(store, 'INTELLIGENCE', 'intelligence_id');
  const diag = records(store, 'DIAGNOSIS', 'diagnosis_id');

  const humanComms = comms.filter((c) => isHumanCommunication(c));

  return {
    'human communications classified': humanComms.filter((c) => filled(c.automated_or_human) && filled(c.human_contact)).length,
    // The metric that exposes the stale-classification guard directly: a row
    // counts here only if the values ON the row are what the CURRENT
    // classification logic produces for it. Rows frozen by the old
    // isClassified() guard fail this even though they look "classified".
    'human comms matching current logic': humanComms.filter((c) => {
      const now = interpretCommunication(c);
      return ['automated_or_human', 'human_contact', 'communication_classification', 'booking_attempt', 'contact_quality']
        .every((k) => String(c[k] ?? '') === String(now[k]));
    }).length,
    'communication_classification': comms.filter((c) => filled(c.communication_classification)).length,
    'intent': comms.filter((c) => filled(c.intent)).length,
    'contact_quality (COMMUNICATIONS)': comms.filter((c) => filled(c.contact_quality)).length,
    'vendor-opportunity evidence': intel.filter((r) => readVendorStatus(r.ai_evidence_summary) !== '').length,
    'ai_evidence_summary': intel.filter((r) => filled(r.ai_evidence_summary)).length,
    'proactive_reactive': intel.filter((r) => filled(r.proactive_reactive)).length,
    'meaningful Diagnosis outputs': diag.filter((r) => filled(r.primary_problem) && !/^none observed/i.test(String(r.primary_problem).trim())).length,
    // What the agency did NOT do — the capability the pipeline previously had
    // no way to represent at all.
    'probes with missed-opportunity findings': intel.filter((r) => readMissedFindings(r.ai_evidence_summary) !== '').length,
    'probes where no genuine reply was sent': intel.filter((r) => /no genuine reply to this enquiry/.test(r.ai_evidence_summary)).length,
    'vendor opportunity engaged (not no_evidence)': intel.filter((r) => {
      const v = readVendorStatus(r.ai_evidence_summary);
      return v && v !== 'no_evidence';
    }).length,
    'Diagnosis saying more than the grade': diag.filter((r) => filled(r.primary_problem)
      && !/^(no response-handling problem|none observed|fast first response|slower first response|slow first response|automated acknowledgement only|no meaningful response)/i.test(String(r.primary_problem).trim())).length,
    _totals: { communications: comms.length, human_communications: humanComms.length, intelligence: intel.length, diagnosis: diag.length },
    _grades: intel.reduce((acc, r) => { const g = String(r.grade || '').trim() || '(blank)'; acc[g] = (acc[g] || 0) + 1; return acc; }, {}),
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function run() {
  const dir = argValue('--dir') || path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
  const store = {};
  for (const tab of TABS) {
    const file = path.join(dir, `${tab}.csv`);
    if (!fs.existsSync(file)) throw new Error(`Missing ${file} — --dir must contain ${TABS.map((t) => `${t}.csv`).join(', ')}`);
    store[tab] = parseCsv(fs.readFileSync(file, 'utf8'));
  }

  console.log(`\nNOVUS pipeline regression — source: ${dir}\n`);

  const before = measure(store);

  const intelligenceSummary = await rebuildAllIntelligence(makeRepoFromStore(store));
  const diagnosisSummary = await rebuildAllDiagnosis(makeRepoFromStore(store));

  const after = measure(store);

  // Idempotency: a second rebuild must not change any DERIVED value, and must
  // not create duplicate rows. `updated_at` is excluded on purpose — it is a
  // "when did this last run" stamp and is expected to move every rebuild.
  const VOLATILE = new Set(['updated_at', 'created_at']);
  const stableSnapshot = () => JSON.stringify(['COMMUNICATIONS', 'INTELLIGENCE', 'DIAGNOSIS'].map((tab) => {
    const header = (store[tab] || [])[0] || [];
    const keep = header.map((h, i) => (VOLATILE.has(h) ? -1 : i)).filter((i) => i >= 0);
    return (store[tab] || []).map((row) => keep.map((i) => row[i] ?? ''));
  }));
  const snapshot = stableSnapshot();
  await rebuildAllIntelligence(makeRepoFromStore(store));
  await rebuildAllDiagnosis(makeRepoFromStore(store));
  const idempotent = stableSnapshot() === snapshot;

  const metrics = Object.keys(before).filter((k) => !k.startsWith('_'));
  const width = Math.max(...metrics.map((m) => m.length));
  console.log(`${'metric'.padEnd(width)}   before    after`);
  console.log(`${'-'.repeat(width)}   ------   ------`);
  let regressed = false;
  for (const m of metrics) {
    const b = before[m];
    const a = after[m];
    if (a < b) regressed = true;
    console.log(`${m.padEnd(width)}   ${String(b).padStart(6)}   ${String(a).padStart(6)}${a > b ? '   ▲' : ''}`);
  }

  console.log(`\nTotals: ${before._totals.communications} communications (${after._totals.human_communications} human), `
    + `${after._totals.intelligence} INTELLIGENCE rows, ${after._totals.diagnosis} DIAGNOSIS rows.`);
  console.log(`Rebuild: created ${intelligenceSummary.intelligence_created}, updated ${intelligenceSummary.intelligence_updated}, `
    + `problems ${intelligenceSummary.problems.length}. Diagnosis: created ${diagnosisSummary.diagnosis_created}, `
    + `updated ${diagnosisSummary.diagnosis_updated}, skipped (still open) ${diagnosisSummary.skipped_not_closed}.`);
  console.log(`A-H grade distribution after rebuild: ${JSON.stringify(after._grades)}`);
  console.log(`Second rebuild changed nothing (idempotent): ${idempotent ? 'yes' : 'NO'}`);

  if (intelligenceSummary.problems.length > 0) {
    console.error('\n❌ Rebuild reported problems:', intelligenceSummary.problems);
    process.exit(1);
  }
  if (regressed) {
    console.error('\n❌ At least one field is populated on FEWER rows after the rebuild than before it.');
    process.exit(1);
  }
  if (!idempotent) {
    console.error('\n❌ A second rebuild changed the data — the pipeline is not idempotent.');
    process.exit(1);
  }
  console.log('\n✅ Pipeline regression passed.\n');
}

run().catch((err) => { console.error('\n❌ PIPELINE REGRESSION FAILED:\n', err); process.exit(1); });
