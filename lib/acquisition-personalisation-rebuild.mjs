// Acquisition-specific PERSONALISATION rebuild.
//
// The commercial facts have already been selected and evidence-gated before
// this stage. The previous acquisition path then spent another Sonnet call just
// to turn those canonical facts into two sentences, even though
// fact-constrained-personalisation.mjs already contains a deterministic,
// validator-backed canonical renderer used as the AI fallback. For acquisition
// that extra model call adds cost and backlog but no new knowledge.
//
// This module keeps the existing PERSONALISATION sheet contract and demo inputs
// intact while rendering the two active outreach fields deterministically.
// It deliberately does NOT replace the older generic personalisation module;
// runRebuildPass opts into this lean path for the sales acquisition pipeline.

import { newPersonalisationId } from './ids.mjs';
import { formatPropertyReference, pickHeroJourney } from './probe-personalisation.mjs';
import { selectPersonalisationFacts } from './personalisation-facts.mjs';
import { renderCanonicalFactCopy, validateFactConstrainedOutput } from './fact-constrained-personalisation.mjs';
import { loadFindingsTable, groupFindingsByProbe, normaliseFindingType } from './diagnosis-findings.mjs';
import { parseDiagnosisFindings } from './probe-diagnosis.mjs';

const REQUIRED_PERSONALISATION_FIELDS = [
  'primary_narrative', 'email_observation', 'email_commercial_hook',
];
const MANDATORY_EMAIL_FIELDS = ['email_observation', 'email_commercial_hook'];

function recordsFromTable({ header, rows }, idColumn) {
  const idIdx = header.indexOf(idColumn);
  const out = [];
  (rows || []).forEach((row, index) => {
    const idVal = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '';
    if (!idVal || idVal === 'SCHEMA NOTE') return;
    const obj = {};
    header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    if (idIdx >= 0) obj[idColumn] = idVal;
    out.push({ rowNumber: index + 2, obj });
  });
  return out;
}

function needsPersonalisation(existingRecord, columns) {
  if (!existingRecord) return true;
  const row = existingRecord.obj || {};
  return REQUIRED_PERSONALISATION_FIELDS
    .filter((field) => !columns || columns.has(field))
    .some((field) => !String(row[field] || '').trim());
}

function blankMandatoryEmailFields(merged, columns) {
  return MANDATORY_EMAIL_FIELDS
    .filter((field) => !columns || columns.has(field))
    .filter((field) => !String(merged?.[field] ?? '').trim());
}

function findingIndexesForFacts(facts) {
  return [...facts.positive, ...facts.problems]
    .flatMap((item) => item.provenance || [])
    .filter((source) => source?.record === 'DIAGNOSIS_FINDINGS')
    .map((source) => Number.parseInt(source.finding_index, 10))
    .filter(Number.isInteger)
    .filter((index, position, all) => all.indexOf(index) === position);
}

function projectPersonalisation({ facts, surface, probe, intelligence, findings, diagnosisContext }) {
  const selectedIndexes = findingIndexesForFacts(facts);
  const positiveIndex = findingIndexesForFacts({ ...facts, problems: [] })[0] ?? null;
  const problemIndexes = findingIndexesForFacts({ ...facts, positive: [] });
  const selectedSet = new Set(selectedIndexes);
  const selectedEvidence = findings
    .filter((finding) => selectedSet.has(Number.parseInt(finding.finding_index, 10)))
    .map((finding) => String(finding.evidence || '').trim())
    .filter(Boolean);
  const supportingFindings = findings
    .filter((finding) => !selectedSet.has(Number.parseInt(finding.finding_index, 10)))
    .map((finding) => String(finding.finding || '').trim())
    .filter(Boolean);

  return {
    hero_journey: pickHeroJourney(intelligence, findings, diagnosisContext),
    primary_narrative: surface.email_observation,
    narrative_finding_indexes: selectedIndexes.join(','),
    positive_finding_index: positiveIndex ?? '',
    main_finding_index: problemIndexes[0] ?? '',
    wider_finding_index: problemIndexes[1] ?? '',
    supporting_findings: supportingFindings.join(' '),
    evidence: selectedEvidence.join(' '),
    novus_counterfactual: '',
    fair_observation: facts.positive[0]?.text || '',
    main_finding: facts.problems[0]?.text || '',
    commercial_consequence: facts.consequences[0]?.text || '',
    property_reference: formatPropertyReference(probe),
    email_observation: surface.email_observation,
    email_commercial_hook: surface.email_commercial_hook,
    enquiry_signals: diagnosisContext.enquiry_signals || '[]',
    unresolved_context: diagnosisContext.unresolved_context || '[]',
    recommended_actions: diagnosisContext.recommended_actions || '[]',
    handling_summary: diagnosisContext.handling_summary || '',
    handling_quality: diagnosisContext.handling_quality || '',
  };
}

function recoveredFindings(diagnosis) {
  return parseDiagnosisFindings(diagnosis)
    .map((finding, index) => ({
      finding_index: index + 1,
      finding_type: normaliseFindingType(finding?.finding_type),
      finding: String(finding?.finding || '').trim(),
      evidence: String(finding?.evidence || '').trim(),
      significance_note: String(finding?.significance_note || '').trim(),
    }))
    .filter((finding) => finding.finding && finding.evidence);
}

export async function rebuildAcquisitionPersonalisation(repo, probesById, opts = {}) {
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;
  const [intelligenceTable, diagnosisTable, personalisationTable, findingsTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
    repo.getTable('PERSONALISATION'),
    loadFindingsTable(repo),
  ]);

  const allIntelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const seenProbeIds = new Set();
  let duplicateIntelligenceRowsSkipped = 0;
  const intelligenceRecords = allIntelligenceRecords.filter((record) => {
    if (seenProbeIds.has(record.obj.probe_id)) {
      duplicateIntelligenceRowsSkipped += 1;
      return false;
    }
    seenProbeIds.add(record.obj.probe_id);
    return true;
  });

  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');
  const personalisationRecords = recordsFromTable(personalisationTable, 'probe_id');
  const diagnosisByProbe = new Map(diagnosisRecords.map((record) => [record.obj.probe_id, record.obj]));
  const personalisationByProbe = new Map(personalisationRecords.map((record) => [record.obj.probe_id, record]));
  const findingsByProbe = groupFindingsByProbe(findingsTable);
  const personalisationColumns = new Set(personalisationTable.header || []);

  const now = new Date();
  const writes = [];
  const problems = [];
  const personalisedProbeIds = [];
  let skippedNotDiagnosed = 0;
  let personalisationCreated = 0;
  let personalisationUpdated = 0;
  let personalisationsWithFindings = 0;
  let findingsRecoveredFromDiagnosisRow = 0;
  let mandatoryFieldRefusals = 0;
  let remainingPersonalisations = 0;
  let nextPersonalisationRow = personalisationTable.rows.length + 2;

  for (const record of intelligenceRecords) {
    const intelligence = record.obj;
    const probeId = intelligence.probe_id;
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;

    const diagnosis = diagnosisByProbe.get(probeId);
    if (!diagnosis || !String(diagnosis.diagnosis_summary || '').trim()) {
      skippedNotDiagnosed += 1;
      continue;
    }

    const existingRecord = personalisationByProbe.get(probeId) || null;
    if (!needsPersonalisation(existingRecord, personalisationColumns)) continue;

    try {
      const probe = (probesById && probesById.get(probeId)) || {};
      let findings = findingsByProbe.get(probeId) || [];
      if (findings.length === 0) {
        const recovered = recoveredFindings(diagnosis);
        if (recovered.length > 0) {
          findings = recovered;
          findingsRecoveredFromDiagnosisRow += 1;
        }
      }

      const diagnosisContext = {
        novus_opportunity: diagnosis.novus_opportunity || '',
        enquiry_signals: diagnosis.enquiry_signals || '[]',
        unresolved_context: diagnosis.unresolved_context || '[]',
        recommended_actions: diagnosis.recommended_actions || '[]',
        handling_summary: diagnosis.handling_summary || '',
        handling_quality: diagnosis.handling_quality || '',
      };

      const facts = selectPersonalisationFacts({ findings, intelligence, probe });
      const canonical = renderCanonicalFactCopy(facts);
      const validated = validateFactConstrainedOutput(facts, canonical);
      if (validated.rejections.length > 0) {
        throw new Error(`Canonical acquisition personalisation failed validation: ${JSON.stringify(validated.rejections)}`);
      }

      const personalisation = projectPersonalisation({
        facts,
        surface: validated.result,
        probe,
        intelligence,
        findings,
        diagnosisContext,
      });
      if (findings.length > 0) personalisationsWithFindings += 1;

      const patch = {
        agency_id: intelligence.agency_id || '',
        probe_id: probeId,
        ...personalisation,
        updated_at: now.toISOString(),
      };

      let rowNumber;
      let merged;
      let createdThisRow = false;
      if (existingRecord) {
        rowNumber = existingRecord.rowNumber;
        merged = { ...existingRecord.obj, ...patch };
      } else {
        rowNumber = nextPersonalisationRow;
        merged = {
          personalisation_id: newPersonalisationId(),
          ...patch,
          created_at: now.toISOString(),
        };
        createdThisRow = true;
      }

      const blankMandatory = blankMandatoryEmailFields(merged, personalisationColumns);
      if (blankMandatory.length > 0) {
        mandatoryFieldRefusals += 1;
        remainingPersonalisations += 1;
        problems.push({
          probe_id: probeId,
          reason: 'mandatory_email_field_blank',
          blank_fields: blankMandatory,
          error: `Personalisation refused: mandatory email field(s) blank — ${blankMandatory.join(', ')}`,
        });
        continue;
      }

      if (createdThisRow) {
        personalisationCreated += 1;
        nextPersonalisationRow += 1;
      } else {
        personalisationUpdated += 1;
      }
      writes.push({
        tab: 'PERSONALISATION',
        rowNumber,
        row: personalisationTable.header.map((key) => merged[key] ?? ''),
      });
      personalisedProbeIds.push(probeId);
    } catch (error) {
      remainingPersonalisations += 1;
      problems.push({ probe_id: probeId, error: error?.message || String(error) });
    }
  }

  await repo.writeRowsBatch(writes);

  return {
    personalisations_processed: personalisationCreated + personalisationUpdated,
    personalisations_with_findings: personalisationsWithFindings,
    mandatory_field_refusals: mandatoryFieldRefusals,
    duplicate_intelligence_rows_skipped: duplicateIntelligenceRowsSkipped,
    findings_recovered_from_diagnosis_row: findingsRecoveredFromDiagnosisRow,
    personalisation_created: personalisationCreated,
    personalisation_updated: personalisationUpdated,
    ai_personalisations_run: 0,
    deterministic_personalisations_run: personalisationCreated + personalisationUpdated,
    remaining_personalisations: remainingPersonalisations,
    skipped_not_diagnosed: skippedNotDiagnosed,
    personalised_probe_ids: personalisedProbeIds,
    problems,
  };
}
