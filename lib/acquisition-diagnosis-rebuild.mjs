// Deterministic acquisition DIAGNOSIS.
//
// INTELLIGENCE already contains the final semantic read of the complete probe
// evidence. For sales acquisition we do not need a second model to restate
// those structured fields as a commercial conclusion. This module projects a
// small conservative findings set from final INTELLIGENCE, writes the existing
// DIAGNOSIS schema, and persists DIAGNOSIS_FINDINGS exactly as the old writer
// did. Unknown seller context is never promoted into a valuation claim.

import { newDiagnosisId } from './ids.mjs';
import { hasVendorDeclaration } from './vendor-intent.mjs';
import { loadFindingsTable, createFindingsWriter } from './diagnosis-findings.mjs';

const VIEWING_RANK = new Map([
  ['none', 0], ['mentioned', 1], ['invited', 2],
  ['availability_requested', 3], ['slot_offered', 4], ['booked', 5],
]);
const SELLER_RANK = new Map([
  ['none', 0], ['asked_position', 1], ['acknowledged', 2],
  ['valuation_offered', 3], ['valuation_booked', 4],
]);

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

function text(value) { return String(value ?? '').trim(); }
function lower(value) { return text(value).toLowerCase(); }
function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function integer(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function finding(finding_type, statement, evidence, significance_note) {
  return { finding_type, finding: statement, evidence, significance_note };
}

function responseEvidence(intelligence) {
  const hours = number(intelligence.response_hours);
  if (hours === null) return 'No human response time was recorded.';
  return `The recorded first-human response time was ${Math.round(hours * 10) / 10} hours.`;
}

function buildStoryFindings(intelligence, probe) {
  const findings = [];
  const human = lower(intelligence.human_contact);
  const responseHours = number(intelligence.response_hours);
  const attempts = integer(intelligence.contact_attempts) ?? 0;
  const followUps = integer(intelligence.follow_ups) ?? 0;
  const channels = text(intelligence.channels_used);
  const viewing = lower(intelligence.viewing_progression);
  const viewingRank = VIEWING_RANK.get(viewing) ?? 0;
  const seller = lower(intelligence.seller_recognition) || 'none';
  const sellerRank = SELLER_RANK.get(seller) ?? 0;
  const qualification = lower(intelligence.buyer_qualification);
  const sellerDeclared = hasVendorDeclaration(probe);

  if (human === 'none') {
    findings.push(finding(
      'problem',
      attempts === 0
        ? 'No human response or agency contact attempt was recorded during the observation window.'
        : 'No human response was recorded during the observation window.',
      attempts === 0
        ? `human_contact=none; contact_attempts=0; channels_used=${channels || '(none)'}.`
        : `human_contact=none; contact_attempts=${attempts}; channels_used=${channels || '(none)'}.`,
      'The enquiry never reached a recorded human conversation.',
    ));
  } else if (responseHours !== null && responseHours > 16) {
    findings.push(finding(
      'problem',
      'The first human response came more than 16 hours after the enquiry.',
      responseEvidence(intelligence),
      'The delay is a concrete handling gap visible without inferring any lost outcome.',
    ));
  }

  if (sellerDeclared && sellerRank < SELLER_RANK.get('valuation_offered')) {
    const statement = sellerRank === 0
      ? 'The property-to-sell declaration was not picked up in the recorded conversation.'
      : 'The property-to-sell declaration was recognised, but its relevance to the move remained unresolved.';
    findings.push(finding(
      'problem',
      statement,
      `The original enquiry declared a property to sell; seller_recognition=${seller || 'none'}.`,
      'This is unresolved moving context, not proof that a valuation should have been offered.',
    ));
  }

  if (human === 'yes' && viewingRank <= VIEWING_RANK.get('mentioned')) {
    findings.push(finding(
      'problem',
      'No concrete viewing invitation, availability request or viewing slot was recorded.',
      `viewing_progression=${viewing || 'none'}.`,
      'The buyer side of the enquiry had no recorded concrete next step towards a viewing.',
    ));
  }

  if (human === 'yes' && qualification === 'none') {
    findings.push(finding(
      'problem',
      'No buyer qualification questions were recorded.',
      `buyer_qualification=${qualification || 'none'}; buyer_questions_asked=${text(intelligence.buyer_questions_asked) || '(none)'}.`,
      'Useful buyer context remained unestablished in the recorded handling.',
    ));
  }

  if (human === 'yes' && attempts === 1 && followUps === 0) {
    findings.push(finding(
      'problem',
      'One human contact attempt was recorded with no follow-up attempt.',
      'contact_attempts=1; follow_ups=0.',
      'The agency made contact once but no later attempt was recorded.',
    ));
  }

  // Keep only the three strongest genuinely different story findings. The
  // ordering is intentional: response/no-response, seller context, then buyer
  // progression/qualification/follow-up.
  return findings.slice(0, 3);
}

function buildPositiveFinding(intelligence) {
  if (lower(intelligence.human_contact) !== 'yes') return null;
  const responseHours = number(intelligence.response_hours);
  const followUps = integer(intelligence.follow_ups) ?? 0;
  const viewing = lower(intelligence.viewing_progression);
  const seller = lower(intelligence.seller_recognition);
  const quality = lower(intelligence.communication_quality);

  let statement = 'The agency made human contact with the enquiry.';
  let evidence = responseHours === null ? 'human_contact=yes.' : `human_contact=yes; response_hours=${Math.round(responseHours * 10) / 10}.`;
  let note = 'The enquiry did receive recorded human handling.';

  if ((VIEWING_RANK.get(viewing) ?? 0) >= VIEWING_RANK.get('availability_requested')) {
    statement = viewing === 'slot_offered'
      ? 'The agency offered a specific viewing slot.'
      : viewing === 'booked'
        ? 'The agency recorded the viewing as booked.'
        : 'The agency asked for viewing availability.';
    evidence = `viewing_progression=${viewing}.`;
    note = 'The buyer enquiry received a concrete next step.';
  } else if ((SELLER_RANK.get(seller) ?? 0) >= SELLER_RANK.get('asked_position')) {
    statement = 'The agency recognised the property-to-sell context.';
    evidence = `seller_recognition=${seller}.`;
    note = 'The wider moving context was noticed rather than ignored.';
  } else if (followUps >= 2) {
    statement = 'The agency followed up persistently.';
    evidence = `follow_ups=${followUps}.`;
    note = 'The team made repeated attempts to continue the enquiry.';
  } else if (responseHours !== null && responseHours <= 1) {
    statement = 'The agency responded quickly.';
    evidence = responseEvidence(intelligence);
    note = 'The initial human handling was prompt.';
  } else if (responseHours !== null && responseHours <= 16) {
    statement = 'The agency responded within 16 hours.';
    evidence = responseEvidence(intelligence);
    note = 'The enquiry received reasonably prompt human handling.';
  } else if (quality === 'strong') {
    statement = 'The recorded communication quality was strong.';
    evidence = 'communication_quality=strong.';
    note = 'The response itself was handled well even if another part of the journey remained unresolved.';
  }

  return finding('positive', statement, evidence, note);
}

function buildSignals(intelligence, probe) {
  const signals = [];
  const responseHours = number(intelligence.response_hours);
  if (responseHours !== null) {
    signals.push({ label: 'First human response', value: `${Math.round(responseHours * 10) / 10} hours`, context: 'Measured from the probe timestamp.', source_type: 'intelligence' });
  } else {
    signals.push({ label: 'Human response', value: lower(intelligence.human_contact) || 'none', context: 'No human response time was recorded.', source_type: 'intelligence' });
  }
  signals.push({ label: 'Contact attempts', value: String(integer(intelligence.contact_attempts) ?? 0), context: 'Deterministic 30-minute attempt grouping.', source_type: 'intelligence' });
  signals.push({ label: 'Follow-ups', value: String(integer(intelligence.follow_ups) ?? 0), context: 'Recorded attempts after the first contact attempt.', source_type: 'intelligence' });
  if (text(intelligence.viewing_progression)) signals.push({ label: 'Viewing progression', value: text(intelligence.viewing_progression), context: 'Final interpretation of the recorded communications.', source_type: 'intelligence' });
  if (hasVendorDeclaration(probe)) signals.push({ label: 'Property to sell declared', value: 'yes', context: 'Declared in the original test enquiry.', source_type: 'probe' });
  return signals.slice(0, 6);
}

function buildUnresolved(intelligence, probe) {
  const unresolved = [];
  const seller = lower(intelligence.seller_recognition) || 'none';
  if (hasVendorDeclaration(probe) && (SELLER_RANK.get(seller) ?? 0) < SELLER_RANK.get('valuation_offered')) {
    unresolved.push({
      question: 'How did the property-to-sell declaration relate to this move?',
      why_it_matters: 'That relationship was not established in the recorded evidence, so no valuation assumption is justified.',
    });
  }
  if (lower(intelligence.human_contact) === 'yes' && lower(intelligence.buyer_qualification) === 'none') {
    unresolved.push({ question: 'What was the buyer\'s position and timescale?', why_it_matters: 'No recorded qualification questions established that context.' });
  }
  if (lower(intelligence.human_contact) === 'yes' && (VIEWING_RANK.get(lower(intelligence.viewing_progression)) ?? 0) <= VIEWING_RANK.get('mentioned')) {
    unresolved.push({ question: 'Did the buyer want to move towards a viewing?', why_it_matters: 'No concrete viewing next step was recorded.' });
  }
  return unresolved.slice(0, 3);
}

function buildActions(intelligence, probe) {
  const actions = [];
  if (lower(intelligence.human_contact) === 'none') {
    actions.push({ title: 'Respond to the enquiry', detail: 'Start a human conversation and establish what the buyer needs next.' });
  }
  const seller = lower(intelligence.seller_recognition) || 'none';
  if (hasVendorDeclaration(probe) && (SELLER_RANK.get(seller) ?? 0) < SELLER_RANK.get('valuation_offered')) {
    actions.push({ title: 'Clarify the seller context', detail: 'Establish whether the declared property to sell is relevant to this move before deciding any commercial next step.' });
  }
  if (lower(intelligence.human_contact) === 'yes' && (VIEWING_RANK.get(lower(intelligence.viewing_progression)) ?? 0) <= VIEWING_RANK.get('mentioned')) {
    actions.push({ title: 'Offer a viewing next step', detail: 'Invite the buyer to arrange a viewing or ask when they are available.' });
  }
  return actions.slice(0, 3);
}

export function buildDeterministicAcquisitionDiagnosis(intelligence, probe) {
  const story = buildStoryFindings(intelligence, probe);
  const positive = buildPositiveFinding(intelligence);
  const findings = [...story, ...(positive ? [positive] : [])];
  const sellerStory = story.some((item) => /property-to-sell|seller/i.test(`${item.finding} ${item.evidence}`));
  const novusOpportunity = story.length === 0
    ? 'None evidenced'
    : (sellerStory ? 'Growth (valuation list / seller conversion)' : 'Core (front desk)');
  const handlingQuality = story.length === 0
    ? (lower(intelligence.human_contact) === 'yes' ? 'strong' : 'weak')
    : (lower(intelligence.human_contact) === 'none' || story.length >= 2 ? 'weak' : 'mixed');
  const responseHours = number(intelligence.response_hours);
  const handlingSummary = lower(intelligence.human_contact) === 'none'
    ? 'No human response was recorded during the observation window.'
    : `Human contact was recorded${responseHours === null ? '' : ` after ${Math.round(responseHours * 10) / 10} hours`}, with viewing_progression=${lower(intelligence.viewing_progression) || 'none'} and follow_ups=${integer(intelligence.follow_ups) ?? 0}.`;
  const strengths = positive ? positive.finding : '';
  const missed = story.map((item) => item.finding).join(' ');
  const implication = story.length
    ? 'The recorded handling left specific enquiry context or next steps unresolved and is worth reviewing.'
    : 'The available evidence does not show a material handling weakness on this probe.';
  const diagnosisSummary = story.length
    ? `${handlingSummary} ${story[0].finding}`
    : `${handlingSummary} No material handling problem is evidenced.`;

  return {
    findings: JSON.stringify(findings),
    enquiry_signals: JSON.stringify(buildSignals(intelligence, probe)),
    unresolved_context: JSON.stringify(buildUnresolved(intelligence, probe)),
    recommended_actions: JSON.stringify(buildActions(intelligence, probe)),
    handling_summary: handlingSummary,
    handling_quality: handlingQuality,
    strengths,
    missed_opportunities: missed,
    commercial_implication: implication,
    novus_opportunity: novusOpportunity,
    diagnosis_summary: diagnosisSummary,
  };
}

export async function rebuildAcquisitionDiagnosis(repo, probesById, opts = {}) {
  const probeIdFilter = opts.probeIds ? new Set(opts.probeIds) : null;
  const finalisedThisPass = opts.finalizedIntelligenceProbeIds
    ? new Set(opts.finalizedIntelligenceProbeIds)
    : null;

  const [intelligenceTable, diagnosisTable, findingsTable] = await Promise.all([
    repo.getTable('INTELLIGENCE'),
    repo.getTable('DIAGNOSIS'),
    loadFindingsTable(repo),
  ]);
  const intelligenceRecords = recordsFromTable(intelligenceTable, 'probe_id');
  const diagnosisRecords = recordsFromTable(diagnosisTable, 'probe_id');
  const diagnosisByProbe = new Map(diagnosisRecords.map((record) => [record.obj.probe_id, record]));
  const findingsWriter = createFindingsWriter(findingsTable);

  const writes = [];
  const problems = [];
  let diagnosisCreated = 0;
  let diagnosisUpdated = 0;
  let skippedNotClosed = 0;
  let remainingDiagnoses = 0;
  let nextDiagnosisRow = diagnosisTable.rows.length + 2;
  const diagnosedProbeIds = [];

  for (const record of intelligenceRecords) {
    const intelligence = record.obj;
    const probeId = intelligence.probe_id;
    if (probeIdFilter && !probeIdFilter.has(probeId)) continue;
    if (finalisedThisPass && !finalisedThisPass.has(probeId)) continue;
    if (lower(intelligence.observation_status) !== 'closed') {
      skippedNotClosed += 1;
      continue;
    }
    const existing = diagnosisByProbe.get(probeId) || null;
    if (existing && text(existing.obj.diagnosis_summary)) continue;

    try {
      const probe = probesById?.get(probeId) || {};
      const diagnosis = buildDeterministicAcquisitionDiagnosis(intelligence, probe);
      const merged = existing
        ? { ...existing.obj, agency_id: intelligence.agency_id || '', probe_id: probeId, ...diagnosis, updated_at: new Date().toISOString() }
        : { diagnosis_id: newDiagnosisId(), agency_id: intelligence.agency_id || '', probe_id: probeId, ...diagnosis, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const rowNumber = existing ? existing.rowNumber : nextDiagnosisRow++;
      if (existing) diagnosisUpdated += 1; else diagnosisCreated += 1;
      writes.push({ tab: 'DIAGNOSIS', rowNumber, row: diagnosisTable.header.map((key) => merged[key] ?? '') });
      findingsWriter.write(probeId, JSON.parse(diagnosis.findings));
      diagnosedProbeIds.push(probeId);
    } catch (error) {
      remainingDiagnoses += 1;
      problems.push({ probe_id: probeId, error: error?.message || String(error) });
    }
  }

  writes.push(...findingsWriter.writes());
  await repo.writeRowsBatch(writes);

  return {
    findings_written: findingsWriter.findingsWritten(),
    diagnoses_processed: diagnosisCreated + diagnosisUpdated,
    diagnosis_created: diagnosisCreated,
    diagnosis_updated: diagnosisUpdated,
    ai_diagnoses_run: 0,
    deterministic_diagnoses_run: diagnosisCreated + diagnosisUpdated,
    remaining_diagnoses: remainingDiagnoses,
    skipped_not_closed: skippedNotClosed,
    diagnosed_probe_ids: diagnosedProbeIds,
    problems,
  };
}
