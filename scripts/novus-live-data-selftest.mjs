// scripts/novus-live-data-selftest.mjs — regression test over the REAL exported
// workbook data (scripts/fixtures/live/*.csv), covering the specific cases the
// end-to-end pipeline audit found.
//
// These are not synthetic shapes. Every assertion below is anchored to an
// actual probe in the live NOVUS workbook, and each one encodes a conclusion a
// competent human analyst reaches from reading that probe's enquiry plus its
// whole communication history — which is the standard the pipeline is being
// held to.
//
// Run: npm run novus:live-data-selftest

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRepo } from '../lib/sheets.mjs';
import { rebuildAllIntelligence } from '../lib/intelligence-rebuild.mjs';
import { rebuildAllDiagnosis } from '../lib/diagnosis-rebuild.mjs';
import { readVendorStatus } from '../lib/vendor-intent.mjs';
import { readMissedFindings } from '../lib/evidence-summary.mjs';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'live');
const TABS = ['PROBES', 'COMMUNICATIONS', 'INTELLIGENCE', 'DIAGNOSIS'];

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c ?? '') !== ''));
}

function loadStore() {
  const store = {};
  for (const tab of TABS) store[tab] = parseCsv(fs.readFileSync(path.join(FIXTURES, `${tab}.csv`), 'utf8'));
  return store;
}

function repoFor(store) {
  const tabOf = (r) => String(r).split('!')[0];
  const startRowOf = (r) => { const m = String(r).match(/!\D+(\d+)/); return m ? parseInt(m[1], 10) : null; };
  return createRepo({
    async get(range) { return (store[tabOf(range)] || []).map((r) => r.slice()); },
    async append(range, rows) {
      const tab = tabOf(range); store[tab] = store[tab] || [];
      for (const r of rows) store[tab].push(r.slice());
      return {};
    },
    async update(range, rows) {
      const tab = tabOf(range); const start = startRowOf(range); store[tab] = store[tab] || [];
      rows.forEach((r, i) => {
        const idx = start - 1 + i;
        while (store[tab].length <= idx) store[tab].push([]);
        const existing = store[tab][idx] || [];
        r.forEach((v, c) => { existing[c] = v; });
        store[tab][idx] = existing;
      });
      return {};
    },
    async batchUpdate(data) { for (const { range, values } of data) await this.update(range, values); return {}; },
  });
}

function records(store, tab, idColumn) {
  const values = store[tab] || []; const header = values[0] || [];
  const idIdx = header.indexOf(idColumn);
  return values.slice(1)
    .filter((r) => r[idIdx] && r[idIdx] !== 'SCHEMA NOTE')
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

async function run() {
  const store = loadStore();
  await rebuildAllIntelligence(repoFor(store));
  await rebuildAllDiagnosis(repoFor(store));

  const comms = records(store, 'COMMUNICATIONS', 'communication_id');
  const intel = records(store, 'INTELLIGENCE', 'intelligence_id');
  const diag = records(store, 'DIAGNOSIS', 'diagnosis_id');
  const I = (pid) => intel.find((r) => r.probe_id === pid);
  const D = (pid) => diag.find((r) => r.probe_id === pid);
  const commsFor = (pid) => comms.filter((c) => c.probe_id === pid);

  // ── prb_hist_0005 (Parabar) ────────────────────────────────────────────────
  // Real history: three near-identical "please find attached the brochure(s)
  // for properties we think will interest you" sends, none naming the probe
  // property, no appointment offered — and nothing else, ever. The pipeline
  // used to grade this B, "fast human contact with genuine follow-up
  // persistence", because the sender was a person and there were three
  // messages. A human analyst would say they never responded at all.
  console.log('\nprb_hist_0005 — bulk brochure blasts are not a response to the enquiry');
  {
    const r = I('prb_hist_0005');
    assert.strictEqual(r.grade, 'H', 'three bulk brochure sends do not constitute a response (was graded B)');
    assert.match(r.ai_evidence_summary, /no genuine reply to this enquiry, despite 3 human message\(s\) being sent/, 'the summary distinguishes "sent things" from "replied"');
    assert.match(readMissedFindings(r.ai_evidence_summary), /every human message was bulk\/template content/, 'the finding names why nothing counted');
    assert.strictEqual(r.first_human_touch, 'no', 'no genuine human touch is recorded');
    ok('bulk/template content no longer counts as a genuine response, on the real Parabar history');
  }

  // ── prb_hist_0012 (Period Homes) ───────────────────────────────────────────
  // Real email body: "Please could you also confirm your position -
  // sold/selling/nothing to sell". That is the agency qualifying the declared
  // vendor opportunity. It matched neither the vendor phrase list nor the
  // communication-quality list, so it was invisible: the probe reported
  // vendor "no_evidence" despite the agency asking the question outright.
  console.log('\nprb_hist_0012 — a direct vendor-position question IS vendor engagement');
  {
    const r = I('prb_hist_0012');
    assert.strictEqual(readVendorStatus(r.ai_evidence_summary), 'acknowledged', 'asking the enquirer to confirm sold/selling raises vendor status above no_evidence');
    const tagged = commsFor('prb_hist_0012').filter((c) => c.intent === 'vendor_acknowledged');
    assert.strictEqual(tagged.length, 1, 'the qualifying message is tagged on COMMUNICATIONS.intent');
    assert.match(D('prb_hist_0012').primary_problem, /never offered a valuation or market appraisal/, 'Diagnosis reports the real gap: noticed but never converted');
    ok('vendor engagement is detected from the conversation, not just from an isolated valuation phrase');
  }

  // ── prb_hist_0015 (HS Estate Agents) ───────────────────────────────────────
  // Rightmove stamped the opportunity into the subject line —
  // "RE: Potential valuation: Ingrave Road - Buyer from CM12" — and the agency
  // replied on that very thread about the viewing only. The opportunity was
  // demonstrably in front of them, which is what makes ignoring it a finding.
  console.log('\nprb_hist_0015 — the portal put the valuation in the subject line the agency replied on');
  {
    const r = I('prb_hist_0015');
    assert.strictEqual(readVendorStatus(r.ai_evidence_summary), 'no_evidence', 'replying about the viewing only is still no vendor engagement');
    assert.match(readMissedFindings(r.ai_evidence_summary), /portal flagged the valuation opportunity in the subject line the agency replied on/, 'the finding records that the opportunity was visible to them, not merely absent');
    ok('a missed opportunity the agency demonstrably saw is reported differently from one that was never surfaced');
  }

  // ── prb_hist_0018 (Smooth Move) ────────────────────────────────────────────
  // Two findings. PROBES.compromised is TRUE (sent with no property-to-sell
  // declaration, so it never tested sell-side behaviour) yet it was being
  // routed to a commercial tier like any other probe. And its final voicemail
  // — "I'm assuming you haven't replied, so you're not really particularly
  // interested" — is the agency closing the lead down itself, the single most
  // commercially interesting behaviour in the whole data set, which the
  // pipeline had no way to represent. Diagnosis said "No response-handling
  // problem".
  console.log('\nprb_hist_0018 — a compromised probe, and an agency that disqualified its own lead');
  {
    const r = I('prb_hist_0018');
    assert.match(r.override_reason, /^COMPROMISED PROBE/, 'the compromised flag is carried onto the Intelligence row');
    assert.strictEqual(readVendorStatus(r.ai_evidence_summary), '', 'no vendor line: this probe never declared a vendor opportunity');
    assert.match(readMissedFindings(r.ai_evidence_summary), /closed the lead down itself/, 'the agency giving up on the lead is recorded as a finding');

    const d = D('prb_hist_0018');
    assert.ok(d, 'the existing DIAGNOSIS row is kept rather than silently orphaned');
    assert.strictEqual(d.primary_problem, '', 'a compromised probe is not given a commercial problem');
    assert.strictEqual(d.tier, '', 'nor a tier — an invalid test must not be routed as a qualified opportunity');
    assert.match(d.evidence_summary, /Not diagnosed — COMPROMISED PROBE/, 'and the row says why, rather than keeping its stale conclusion');
    ok('compromised probes are graded but never routed commercially, and stale conclusions are cleared');
  }

  // ── prb_hist_0004 / voicemail-only probes ──────────────────────────────────
  // Guard against a false positive found during the audit: address matching
  // used to accept postcode fragments ("cm11") and house numbers ("151a"), so
  // any probe whose only reply was a voicemail got flagged for never naming
  // the property — because nobody recites a postcode on the phone.
  console.log('\nprb_hist_0004 — absence of evidence is not evidence of absence');
  {
    const missed = readMissedFindings(I('prb_hist_0004').ai_evidence_summary);
    assert.doesNotMatch(missed, /never named the property/, 'a voicemail-only probe is not accused of failing to name the property');
    ok('the property-naming finding needs a distinctive address AND a written reply before it will fire');
  }

  // ── prb_hist_0001 — genuinely nothing happened ─────────────────────────────
  // Five probes in the live data received no communication whatsoever. The
  // instruction "do not blindly populate every field" applies most sharply
  // here: with no communications there is nothing to conclude beyond the grade.
  console.log('\nprb_hist_0001 — a blank stays blank when there is genuinely no evidence');
  {
    const r = I('prb_hist_0001');
    assert.strictEqual(r.grade, 'H', 'four days of silence is H');
    assert.strictEqual(readMissedFindings(r.ai_evidence_summary), '', 'no missed-opportunity findings are invented for a probe with zero communications');
    assert.match(r.ai_evidence_summary, /no communication of any kind was observed/, 'the summary states the absence plainly');
    ok('no findings are fabricated where the agency did nothing at all — grade H already says it');
  }

  // ── ai_summary is read, never written ──────────────────────────────────────
  // 54 of the 77 live COMMUNICATIONS rows carry an analyst-grade sentence in
  // ai_summary that nothing in the pipeline had ever read.
  console.log('\nCOMMUNICATIONS.ai_summary is used as evidence and never overwritten');
  {
    const original = parseCsv(fs.readFileSync(path.join(FIXTURES, 'COMMUNICATIONS.csv'), 'utf8'));
    const header = original[0];
    const idIdx = header.indexOf('communication_id');
    const sumIdx = header.indexOf('ai_summary');
    const before = new Map(original.slice(1).filter((r) => r[idIdx] && r[idIdx] !== 'SCHEMA NOTE').map((r) => [r[idIdx], r[sumIdx] ?? '']));
    for (const c of comms) {
      assert.strictEqual(c.ai_summary, before.get(c.communication_id), `ai_summary preserved verbatim on ${c.communication_id}`);
    }
    assert.match(I('prb_hist_0005').ai_evidence_summary, /Bulk brochure send from a named mailbox/, "the probe narrative quotes the row's own ai_summary rather than a truncated raw body");
    ok('the existing per-message analysis is consumed by the probe narrative, and left untouched on the row');
  }

  // ── A-H grading stays a speed/persistence measure ──────────────────────────
  console.log('\nA-H grading remains speed/persistence only');
  {
    for (const r of intel) {
      if (!r.grade || r.grade === 'pending') continue;
      assert.match(r.grade_reason, /Source Master §10|human_lag_hours could not be computed/, `${r.probe_id}: the grade reason still comes from the grading engine alone`);
    }
    // The vendor status is the strongest non-speed signal in the data; it must
    // not correlate with the grade by construction.
    const acknowledged = intel.filter((r) => readVendorStatus(r.ai_evidence_summary) === 'acknowledged');
    assert.ok(acknowledged.length > 0, 'the live data contains at least one vendor-acknowledged probe');
    ok('every grade is still justified purely by the A-H rules; vendor and evidence findings never enter it');
  }

  // ── idempotency on real data ───────────────────────────────────────────────
  console.log('\nRebuilding the real workbook twice changes nothing');
  {
    const VOLATILE = new Set(['updated_at', 'created_at']);
    const snapshot = () => JSON.stringify(TABS.map((tab) => {
      const header = (store[tab] || [])[0] || [];
      const keep = header.map((h, i) => (VOLATILE.has(h) ? -1 : i)).filter((i) => i >= 0);
      return (store[tab] || []).map((row) => keep.map((i) => row[i] ?? ''));
    }));
    const first = snapshot();
    await rebuildAllIntelligence(repoFor(store));
    await rebuildAllDiagnosis(repoFor(store));
    assert.strictEqual(snapshot(), first, 'a second rebuild over the real workbook is a no-op');
    ok('idempotent against the real 39-probe / 77-communication workbook');
  }

  console.log(`\n✅ All ${passed} checks passed.\n`);
}

run().catch((err) => { console.error('\n❌ LIVE DATA SELFTEST FAILED:\n', err); process.exit(1); });
