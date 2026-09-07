// lib/personalisation-rebuild.mjs — the canonical full-rebuild path for
// PERSONALISATION, one step after DIAGNOSIS in the pipeline (COMMUNICATIONS
// = evidence, INTELLIGENCE = interpretation, DIAGNOSIS = commercial
// conclusion, PERSONALISATION = that evidence + conclusion turned into the
// agency-specific acquisition story). Same batch-load-once / no-per-write-
// read shape as lib/diagnosis-rebuild.mjs.
//
// Only runs for probes whose DIAGNOSIS is already finalised (non-blank
// diagnosis_summary) — Personalisation reads Diagnosis as settled, it never
// races ahead of it. Like DIAGNOSIS, once a probe's PERSONALISATION row has
// content (non-blank primary_narrative) it is FROZEN for good: nothing
// regenerates it, not even a forced rebuild — the story a prospect was sent
// should not silently change under them.
//
// IMPORTANT: "Diagnosis is finalised" is the ONLY gate here — this step has
// no way to tell a probe whose Diagnosis was JUST regenerated in this same
// pass apart from one that has carried a non-blank diagnosis_summary for
// weeks. So on a workbook with an empty PERSONALISATION tab (e.g. right
// after that tab is first created), unfreezing even one historical probe's
// DIAGNOSIS.diagnosis_summary makes EVERY OTHER already-diagnosed historical
// probe look identically eligible too — none of them has a PERSONALISATION
// row yet, so needsPersonalisation() is true for all of them, not just the
// one that was unfrozen. A full rebuild pass then personalises all of them
// in one go. Use opts.probeIds below to restrict a run to a known set of
// probes when that full sweep is not what you want (e.g. testing a handful
// of probes without spending AI on the rest).
//
// ZERO ANTHROPIC CALLS. This step used to call a model to surface-realise the
// two email sentences — from canonical facts a deterministic selector had
// already chosen, through a validator strict enough to reject anything the
// model added. lib/fact-constrained-personalisation.mjs's
// renderCanonicalFactCopy() was already producing those sentences as the
// fallback; it is now simply the path. The validator is unchanged and still
// runs: a rendering that fails it is refused, not repaired.
//
// The AI realiser is retained in that module behind its explicit
// { enabled: true } flag for debug/experimental comparison only. Nothing in the
// nightly cron, the rebuild button or the backlog recovery reaches it, which is
// why ai_personalisations_run below is structurally 0.
//
// WHAT THE SELECTOR IS HANDED: PERSONALISATION_FACTS only. The selector
// deterministically derives those canonical facts from DIAGNOSIS_FINDINGS and
// structured INTELLIGENCE/PROBES state before the constrained surface
// realiser is called. Raw findings/evidence, probe data, DIAGNOSIS prose,
// INTELLIGENCE rows and COMMUNICATIONS never cross the AI boundary.
//
// AND THE DIAGNOSIS ROW ITSELF NO LONGER LEAVES THIS FILE. Not passing the
// prose to the MODEL was only half of it: the row object used to be handed to
// the free-form generator, so "Personalisation does not read DIAGNOSIS prose"
// was a convention one edit away from being untrue. Only novus_opportunity — a
// three-value enum, not prose — is handed across now, in a fresh object built
// at the call site below. DIAGNOSIS_FINDINGS is the single authoritative
// commercial interpretation layer; the DIAGNOSIS prose fields are
// NON-AUTHORITATIVE and reach nothing downstream of this file.
//
// PERSONALISATION_FACTS is the layer that selects which findings are safe to
// surface; the realiser only orders and grammatically combines those facts.
//
// Idempotent: PERSONALISATION is upserted exactly one row per probe_id.

import { newPersonalisationId } from './ids.mjs';
import { pickHeroJourney } from './probe-personalisation.mjs';
import { selectPersonalisationFacts } from './personalisation-facts.mjs';
import { renderPersonalisationFromFacts } from './fact-constrained-personalisation.mjs';
import { loadFindingsTable, groupFindingsByProbe, normaliseFindingType } from './diagnosis-findings.mjs';
import { parseDiagnosisFindings } from './probe-diagnosis.mjs';

// PERSONALISATION retains several pre-outreach columns used by the freeze
// gate, audit trail and DEMOS compiler. They are now a deterministic
// compatibility projection of the same selected facts; the AI returns only
// the two active outreach sentences. The historical Hook 2 sheet column is
// deliberately left untouched and is no longer part of this projection.
function projectFactConstrainedPersonalisation({ facts, surface, probe, intelligence, findings, diagnosisContext }) {
  return {
    hero_journey: pickHeroJourney(intelligence, findings, diagnosisContext),
    fair_observation: facts.positive[0]?.text || '',
    main_finding: facts.problems[0]?.text || '',
    commercial_consequence: facts.consequences[0]?.text || '',
    email_observation: surface.email_observation,
    email_commercial_hook: surface.email_commercial_hook,
    enquiry_signals: diagnosisContext.enquiry_signals || '[]',
    unresolved_context: diagnosisContext.unresolved_context || '[]',
    handling_summary: diagnosisContext.handling_summary || '',
    handling_quality: diagnosisContext.handling_quality || '',
  };
}

// THE CANONICAL FINDINGS RECORD, AND WHY IT MOVED.
//
// DIAGNOSIS_FINDINGS used to be read first, which made a large, growing tab a
// mandatory read on the active path for every rebuild — hundreds of granular
// rows downloaded and regrouped just to produce two email sentences and a demo.
// The identical findings have always ALSO been written, as one JSON array, onto
// the probe's own DIAGNOSIS row, and that is now the source of truth: one
// canonical structured record per probe, already loaded with the DIAGNOSIS
// table this step reads anyway, costing no extra request.
//
// The tab is kept and still written (lib/assessment-rebuild.mjs) as a
// compatibility projection for audit/history — and it is still read HERE, as a
// FALLBACK, for any historical probe whose DIAGNOSIS.findings cell is blank or
// unparsable but whose rows exist. Nothing historical is dropped; the expensive
// read is simply no longer the default.
function canonicalFindings(diagnosis) {
  return parseDiagnosisFindings(diagnosis)
    .map((f, i) => ({
      finding_index: Number(f?.finding_index) || i + 1,
      // A record written before finding_type existed normalises to 'problem' —
      // never to 'positive', so this can never manufacture praise the
      // assessment never recorded.
      finding_type: normaliseFindingType(f?.finding_type),
      finding: String(f?.finding || '').trim(),
      evidence: String(f?.evidence || '').trim(),
      significance_note: String(f?.significance_note || '').trim(),
    }))
    .filter((f) => f.finding && f.evidence)
    .sort((a, b) => a.finding_index - b.finding_index);
}

// idVal is TRIMMED and written back onto obj[idColumn] — a stray leading/
// trailing space typed into the sheet by hand must not make this row invisible
// to a later probe_id lookup (Map keys built from this obj must match exactly
// what INTELLIGENCE/DIAGNOSIS's own recordsFromTable produces for the same
// probe, or an existing PERSONALISATION row silently stops being found and a
// duplicate gets appended instead of updated in place).
function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  rows.forEach((row, i) => {
    const idVal = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    if (idIdx >= 0) obj[idColumn] = idVal;
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// A row counts as already personalised once both live email fields are set.
// Historical prose columns remain readable but are no longer a write target.
// Deliberately does not take forceAi — see the file header.
//
// columns: the PERSONALISATION tab's actual header. A field the SHEET does not
// have a column for is skipped, because a value written for it goes nowhere
// (writeRowsBatch maps by header) and would therefore read back blank on the
// next pass — re-personalising every probe, every run, for ever. So the
// workbook gets the new column when the schema doc says so, and until it does
// this step behaves exactly as it did before the field existed rather than
// spending AI in a loop.
const REQUIRED_PERSONALISATION_FIELDS = ['email_observation', 'email_commercial_hook'];

export function needsPersonalisation(existingRecord, columns) {
  if (!existingRecord) return true;
  const row = existingRecord.obj || {};
  return REQUIRED_PERSONALISATION_FIELDS
    .filter((field) => !columns || columns.has(field))
    .some((field) => !String(row[field] || '').trim());
}

// ── The terminal persistence invariant ──────────────────────────────────────
//
// THE TWO ACTIVE EMAIL VARIABLES ARE MANDATORY, AND THAT IS ENFORCED
// EXCEPT AT THE WRITE. Any generator can return one of them blank, and a blank
// there is a REFUSAL, not a result. The terminal check remains independent of
// the active generator so rollback or a future replacement cannot weaken it.
//
// A blank can otherwise flow straight through `patch`, overwrite a valid
// active email field, and become a silently degraded row downstream.
//
// This is the one gate. lib/personalisation-rebuild.mjs holds the ONLY
// PERSONALISATION write in the codebase, so append, update, regeneration,
// fallback, correction and partial-merge paths all funnel through the single
// call site below and all get this check.
//
// SCOPED TO COLUMNS THE SHEET ACTUALLY HAS, for the same reason
// needsPersonalisation() is: a workbook whose header predates a field cannot
// store it, so demanding it would refuse every row for ever instead of
// behaving as it did before the field existed.
//
// It does not repair, substitute or invent anything — there is no correct
// value to invent. It refuses the write and says exactly which fields were
// blank, so the probe keeps no row (or keeps its existing good one) and the
// next pass retries it.
export const MANDATORY_EMAIL_FIELDS = [
  'email_observation', 'email_commercial_hook',
];

// -> [] when the row may be written, or the list of blank mandatory fields.
// Whitespace is blank: a cell holding ' ' is not a sentence, and it would
// otherwise satisfy every truthiness check between here and the sheet.
export function blankMandatoryEmailFields(merged, columns) {
  return MANDATORY_EMAIL_FIELDS
    .filter((field) => !columns || columns.has(field))
    .filter((field) => !String(merged?.[field] ?? '').trim());
}

// repo, probesById: Map(probe_id -> PROBES obj), opts?: { maxAiCalls?: number }
// -> { personalisations_processed, personalisation_created,
//      personalisation_updated, ai_personalisations_run,
//      remaining_personalisations, skipped_not_diagnosed,
//      personalised_probe_ids, problems }
//
// personalised_probe_ids is the list of probes whose PERSONALISATION row this
// pass actually wrote. lib/rebuild-pass.mjs hands it straight to the DEMOS
// compile step, which is what makes "PERSONALISATION completes -> the demo
// exists" one invocation rather than a separate job.
//
// ai_personalisations_run counts AI CALLS, not probes, and maxAiCalls caps the
// same number: one probe normally costs one call; an invalid selection or
// incoherent new email variable can cost one bounded correction call. Probes
// are counted by personalisations_processed.
export async function rebuildAllPersonalisation(repo, probesById, opts = {}) {
  // maxAiCalls is accepted and IGNORED. This step is deterministic, so a
  // spent AI budget must never stop it: the specific failure this fixes is a
  // nightly run whose 15 assessments used the whole budget, leaving 50
  // already-diagnosed leads unpersonalised — and therefore with no demo and no
  // OUTBOUND row — for no reason at all.
  void opts.maxAiCalls;
  // opts.probeIds?: iterable of probe_id — restricts this rebuild to exactly
  // those probes, same targeting option as rebuildAllIntelligence and
  // rebuildAllDiagnosis. Absent (the default) processes every diagnosed,
  // unpersonalised probe, same as before this option existed — see the file
  // header for why that default swept up every already-diagnosed historical
  // probe the one time this mattered.
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;

  const [intelligenceTable, diagnosisTable, personalisationTable, agenciesTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
    repo.getTable('PERSONALISATION'),
    repo.getTable('AGENCIES'),
  ]);

  // DIAGNOSIS_FINDINGS IS LOADED LAZILY, AND USUALLY NOT AT ALL. It is only
  // the fallback for a historical probe whose canonical DIAGNOSIS.findings cell
  // is blank; on a normal pass no probe needs it and the tab — the largest and
  // fastest-growing in the workbook — is never downloaded.
  let findingsByProbeCache = null;
  async function findingsFromTab(probeId) {
    if (!findingsByProbeCache) findingsByProbeCache = groupFindingsByProbe(await loadFindingsTable(repo));
    return findingsByProbeCache.get(probeId) || [];
  }

  // ONE PROBE = ONE VISIT, for the same reason lib/diagnosis-rebuild.mjs
  // dedupes: this loop walks INTELLIGENCE ROWS, and a workbook carrying two
  // rows for one probe_id would otherwise personalise it twice in a single
  // pass — the second visit sees the same stale personalisationByProbe map,
  // finds no existing row, and appends a SECOND PERSONALISATION row. The
  // invariant is one row per probe per rebuild, so it is enforced here rather
  // than assumed of the upstream table.
  const allIntelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const seenProbeIds = new Set();
  let duplicateIntelligenceRowsSkipped = 0;
  const intelligenceRecords = allIntelligenceRecords.filter((rec) => {
    if (seenProbeIds.has(rec.obj.probe_id)) {
      duplicateIntelligenceRowsSkipped += 1;
      return false;
    }
    seenProbeIds.add(rec.obj.probe_id);
    return true;
  });
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');
  const personalisationRecords = recordsFromTable(personalisationTable, 'probe_id');
  const agencyRecords = recordsFromTable(agenciesTable, 'agency_id');

  const diagnosisByProbe = new Map(diagnosisRecords.map((r) => [r.obj.probe_id, r.obj]));
  const personalisationByProbe = new Map(personalisationRecords.map((r) => [r.obj.probe_id, r]));
  const agencyById = new Map(agencyRecords.map((r) => [r.obj.agency_id, r.obj]));
  const personalisationColumns = new Set(personalisationTable.header || []);

  const now = new Date();
  let skippedNotDiagnosed = 0;
  let validatorRefusals = 0;
  const problems = [];
  const writes = [];
  let personalisationCreated = 0;
  let personalisationUpdated = 0;
  const personalisedProbeIds = [];
  let personalisationsWithFindings = 0;
  // Rows refused by the terminal invariant below. Reported rather than hidden:
  // a pass that refuses rows is doing its job, but it must be visible that it
  // did, and how often.
  let mandatoryFieldRefusals = 0;
  let findingsRecoveredFromFindingsTab = 0;
  let nextPersonalisationRow = personalisationTable.rows.length + 2;

  for (const rec of intelligenceRecords) {
    const intelligence = rec.obj;
    const probeId = intelligence.probe_id;

    // Targeting filter: skip silently, before anything else.
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;

    const diagnosis = diagnosisByProbe.get(probeId);
    if (!diagnosis || !String(diagnosis.diagnosis_summary || '').trim()) {
      skippedNotDiagnosed += 1;
      continue;
    }

    try {
      const existingRecord = personalisationByProbe.get(probeId) || null;
      if (!needsPersonalisation(existingRecord, personalisationColumns)) continue;

      const probe = (probesById && probesById.get(probeId)) || {};
      const agency = agencyById.get(intelligence.agency_id) || {};
      // FINDINGS ARE THE INPUT, AND SILENCE IS NOT AN ACCEPTABLE ANSWER.
      // An empty findings list is a real, meaningful state — it means
      // Diagnosis found no genuine problem — and the prompt says exactly that
      // to the model. So "the DIAGNOSIS_FINDINGS rows are missing" must never
      // be allowed to look like it: that would quietly tell the model this
      // enquiry was handled perfectly and let it write the story off the
      // Diagnosis prose instead of the findings.
      //
      // The rows are the source of truth. Only when a diagnosed probe has NO
      // rows at all AND its own DIAGNOSIS.findings cell still holds the JSON
      // array Diagnosis produced do we read them back from there — the same
      // findings, from the other place the same step already wrote them, never
      // re-derived and never invented. (Reachable for any probe diagnosed
      // before DIAGNOSIS_FINDINGS existed, or by a path that did not yet write
      // it.) Counted, not silent, so a workbook drifting into that state shows
      // up in the summary instead of degrading the emails quietly.
      let findings = canonicalFindings(diagnosis);
      if (findings.length === 0) {
        const fromTab = await findingsFromTab(probeId);
        if (fromTab.length > 0) {
          findings = fromTab;
          findingsRecoveredFromFindingsTab += 1;
        }
      }
      // No AI call, no budget, no correction round-trip — see the file header.
      // THE DIAGNOSIS ROW DOES NOT GO DOWNSTREAM — one enum does.
      // This step still READS the DIAGNOSIS row, for two mechanical reasons
      // that have nothing to do with what it says: the eligibility gate above
      // (a non-blank diagnosis_summary is the "finalised" flag, never read as
      // text) and the structured findings recovery below. Neither is a
      // commercial interpretation. What Personalisation is ALLOWED to act on
      // is DIAGNOSIS_FINDINGS plus the deterministic INTELLIGENCE fields, so
      // the only thing handed across is novus_opportunity — the three-value
      // enum the deterministic hero-journey lookup needs. The prose fields
      // (diagnosis_summary, strengths, missed_opportunities,
      // commercial_implication) are NON-AUTHORITATIVE and never cross.
      const diagnosisContext = {
        novus_opportunity: diagnosis.novus_opportunity || '',
        enquiry_signals: diagnosis.enquiry_signals || '[]',
        unresolved_context: diagnosis.unresolved_context || '[]',
        handling_summary: diagnosis.handling_summary || '',
        handling_quality: diagnosis.handling_quality || '',
      };
      const personalisationFacts = selectPersonalisationFacts({ findings, intelligence, probe });
      const { rejections, ai_calls_used: _zero, ...surface } = renderPersonalisationFromFacts(personalisationFacts);
      // A deterministic rendering that fails the unchanged factual validator is
      // a REFUSAL, exactly as an AI rendering that failed it was: no write, no
      // demo, reported with the reasons, retried next pass.
      if (rejections.length > 0) {
        validatorRefusals += 1;
        problems.push({
          probe_id: probeId,
          reason: 'canonical_rendering_rejected',
          rejections,
          error: `Personalisation refused: canonical rendering failed validation — ${rejections.map((r) => `${r.field}: ${r.reason}`).join('; ')}`,
        });
        continue;
      }
      const personalisation = projectFactConstrainedPersonalisation({
        facts: personalisationFacts,
        surface,
        probe,
        intelligence,
        findings,
        diagnosisContext,
      });
      // Counted AFTER the call returns, so it reports probes PERSONALISED with
      // findings rather than probes that merely reached the attempt. Counting
      // it before made a pass in which every probe threw report
      // personalisations_with_findings=5 alongside zero AI calls, zero writes
      // and zero remaining — an internally impossible-looking summary whose
      // only honest signal was `problems`.
      if (findings.length > 0) personalisationsWithFindings += 1;

      const personalisationId = existingRecord ? existingRecord.obj.personalisation_id : newPersonalisationId();
      const patch = {
        agency_id: intelligence.agency_id || '',
        probe_id: probeId,
        ...personalisation,
        updated_at: now.toISOString(),
      };

      let rowNumber;
      let merged;
      if (existingRecord) {
        rowNumber = existingRecord.rowNumber;
        merged = { ...existingRecord.obj, ...patch };
        personalisationUpdated += 1;
      } else {
        rowNumber = nextPersonalisationRow;
        nextPersonalisationRow += 1;
        merged = { personalisation_id: personalisationId, ...patch, created_at: now.toISOString() };
        personalisationCreated += 1;
      }
      // THE TERMINAL INVARIANT — see blankMandatoryEmailFields() above. Checked
      // against `merged`, which is the exact object about to become the row, so
      // it sees the result of the update branch's spread as well as a fresh
      // row: a blank arriving from personaliseProbe cannot overwrite a good
      // existing value, because the merged result is what fails.
      //
      // Refusing is the whole point. No write, no update, no counter increment,
      // and the probe is NOT added to personalised_probe_ids — so the DEMOS
      // compile step downstream never builds a demo from a row that does not
      // exist. It is reported as a problem, with the reason and the exact
      // fields, and the next pass picks the probe up again.
      const blankMandatory = blankMandatoryEmailFields(merged, personalisationColumns);
      if (blankMandatory.length > 0) {
        if (existingRecord) personalisationUpdated -= 1;
        else {
          personalisationCreated -= 1;
          nextPersonalisationRow -= 1;
        }
        mandatoryFieldRefusals += 1;
        problems.push({
          probe_id: probeId,
          reason: 'mandatory_email_field_blank',
          blank_fields: blankMandatory,
          error: `Personalisation refused: mandatory email field(s) blank after correction — ${blankMandatory.join(', ')}`,
        });
        continue;
      }

      const row = personalisationTable.header.map((key) => (merged[key] ?? ''));
      writes.push({ tab: 'PERSONALISATION', rowNumber, row });
      personalisedProbeIds.push(probeId);
    } catch (err) {
      problems.push({ probe_id: probeId, error: err.message || String(err) });
    }
  }

  await repo.writeRowsBatch(writes);

  return {
    personalisations_processed: personalisationCreated + personalisationUpdated,
    personalisations_with_findings: personalisationsWithFindings,
    mandatory_field_refusals: mandatoryFieldRefusals,
    duplicate_intelligence_rows_skipped: duplicateIntelligenceRowsSkipped,
    findings_recovered_from_findings_tab: findingsRecoveredFromFindingsTab,
    personalisation_created: personalisationCreated,
    personalisation_updated: personalisationUpdated,
    // Structurally zero, and structurally nothing left over: a deterministic
    // step either writes the row or refuses it, it never runs out of budget.
    ai_personalisations_run: 0,
    remaining_personalisations: 0,
    validator_refusals: validatorRefusals,
    skipped_not_diagnosed: skippedNotDiagnosed,
    personalised_probe_ids: personalisedProbeIds,
    problems,
  };
}
