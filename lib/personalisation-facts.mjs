// Deterministic, additive fact selection between DIAGNOSIS_FINDINGS plus the
// existing structured INTELLIGENCE/PROBES facts and Personalisation.
//
// Phase 1 deliberately has no callers in the production generation path. It
// turns supported upstream facts into a small, canonical vocabulary that can
// be inspected and tested before Personalisation is allowed to consume it.

import { normaliseFindingType } from './diagnosis-findings.mjs';
import { ONE_HOUR_MS, SIXTEEN_HOUR_MS } from './grading.mjs';

const ONE_HOUR = ONE_HOUR_MS / ONE_HOUR_MS;
const SIXTEEN_HOURS = SIXTEEN_HOUR_MS / ONE_HOUR_MS;

const SELLER_DECLARATION_RE = /\b(?:property|home|house|flat|apartment)\s+to\s+sell\b|\b(?:seller|vendor)\b|\bnot\s+yet\s+on\s+the\s+market\b/i;
const SELLER_FINDING_RE = /\b(?:seller|vendor|valuation|property\s+to\s+sell|own\s+property|declared\s+property|has\s+to\s+sell|not\s+yet\s+on\s+the\s+market)\b/i;
const RESPONSE_FINDING_RE = /\b(?:response\s+time|hours?\b|human\s+(?:reply|response|contact)|no\s+(?:meaningful\s+)?response|nothing\s+came\s+back|never\s+replied)\b/i;
const BUYER_PROGRESSION_RE = /\b(?:viewing|availability|slot|book(?:ed|ing)?|progress(?:ed|ion)?|move\s+(?:this|the\s+enquiry)\s+forward|offered?)\b/i;
const BUYER_QUALIFICATION_RE = /\b(?:buyer\s+qualification|qualification\s+depth|qualifying\s+question|questions?\s+asked)\b/i;
const FOLLOW_UP_RE = /\b(?:follow[- ]?ups?|contact\s+attempts?)\b/i;
const UNKNOWN_CONTENT_RE = /\b(?:no\s+(?:available\s+)?content(?:\s*\/\s*|\s+or\s+)?transcript|no\s+transcript|content\s+unknown|transcript\s+unavailable)\b/i;
const INCOMPLETE_CONTENT_RE = /\b(?:message\s+ends\s+there|record(?:ing)?\s+(?:is\s+)?incomplete|as\s+captured\s+only\s+says|truncated\s+(?:message|recording|transcript))\b/i;

const VIEWING_RANK = new Map([
  ['none', 0],
  ['mentioned', 1],
  ['invited', 2],
  ['availability_requested', 3],
  ['slot_offered', 4],
  ['booked', 5],
]);

const SELLER_RANK = new Map([
  ['none', 0],
  ['asked_position', 1],
  ['acknowledged', 2],
  ['valuation_offered', 3],
  ['valuation_booked', 4],
]);

const PROBLEM_PRIORITY = new Map([
  ['complete_miss', 0],
  ['no_human_response', 1],
  ['slow_human_response', 2],
  ['seller_not_recognised', 3],
  ['seller_recognised_not_progressed', 4],
  ['buyer_not_progressed', 5],
  ['buyer_not_qualified', 6],
  ['no_follow_up', 7],
  ['communication_record_incomplete', 8],
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function findingText(finding) {
  return `${clean(finding.finding)} ${clean(finding.evidence)}`.trim();
}

function validFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((finding) => clean(finding?.finding) && clean(finding?.evidence))
    .map((finding, position) => ({
      ...finding,
      finding_index: number(finding.finding_index) ?? position + 1,
      finding_type: normaliseFindingType(finding.finding_type),
    }))
    .sort((a, b) => a.finding_index - b.finding_index);
}

function findingSource(finding) {
  return { record: 'DIAGNOSIS_FINDINGS', finding_index: finding.finding_index };
}

function intelligenceSource(...fields) {
  return { record: 'INTELLIGENCE', fields };
}

function probeSource(...fields) {
  return { record: 'PROBES', fields };
}

function fact(type, text, sources) {
  return { type, text, provenance: sources };
}

function firstFinding(findings, predicate) {
  return findings.find(predicate) || null;
}

function hasSellerDeclaration(probe) {
  return SELLER_DECLARATION_RE.test(clean(probe?.enquiry_text));
}

function uncertainContentFinding(findings) {
  return firstFinding(findings, (finding) => {
    const text = findingText(finding);
    return UNKNOWN_CONTENT_RE.test(text) || INCOMPLETE_CONTENT_RE.test(text);
  });
}

function selectPositive({ positiveFindings, intelligence, sellerDeclared }) {
  // A structured metric is not silently promoted into praise. At least one
  // upstream positive finding must exist before this category can be filled.
  if (positiveFindings.length === 0) return [];

  const support = findingSource(positiveFindings[0]);
  const humanContact = clean(intelligence.human_contact).toLowerCase();
  const responseHours = number(intelligence.response_hours);
  const viewing = clean(intelligence.viewing_progression).toLowerCase();
  const viewingRank = VIEWING_RANK.get(viewing);
  const seller = clean(intelligence.seller_recognition).toLowerCase();
  const sellerRank = SELLER_RANK.get(seller);
  const followUps = integer(intelligence.follow_ups);

  if (viewingRank !== undefined && viewingRank >= VIEWING_RANK.get('availability_requested')) {
    const labels = {
      availability_requested: 'The agency requested the buyer\'s availability for a viewing.',
      slot_offered: 'The agency offered the buyer a specific viewing slot.',
      booked: 'The agency recorded the buyer\'s viewing as booked.',
    };
    return [fact('concrete_buyer_next_step', labels[viewing], [support, intelligenceSource('viewing_progression')])];
  }

  if (sellerDeclared && sellerRank !== undefined && sellerRank >= SELLER_RANK.get('asked_position')) {
    const labels = {
      asked_position: 'The agency asked about the declared seller opportunity.',
      acknowledged: 'The agency acknowledged the declared seller opportunity.',
      valuation_offered: 'The agency offered a valuation for the declared seller opportunity.',
      valuation_booked: 'The agency recorded a valuation as booked for the declared seller opportunity.',
    };
    return [fact('seller_opportunity_recognised', labels[seller], [support, intelligenceSource('seller_recognition'), probeSource('enquiry_text')])];
  }

  if (followUps !== null && followUps >= 2) {
    return [fact('persistent_follow_up', `The agency made ${followUps} follow-up attempts.`, [support, intelligenceSource('follow_ups')])];
  }

  if (humanContact === 'yes' && responseHours !== null && responseHours <= ONE_HOUR) {
    return [fact('human_response_fast', 'A human response was recorded within 1 hour.', [support, intelligenceSource('human_contact', 'response_hours')])];
  }

  if (humanContact === 'yes' && responseHours !== null && responseHours <= SIXTEEN_HOURS) {
    return [fact('human_response_within_16h', 'A human response was recorded within 16 hours.', [support, intelligenceSource('human_contact', 'response_hours')])];
  }

  return [];
}

function selectProblemCandidates({ storyFindings, intelligence, sellerDeclared, contentUncertain }) {
  const candidates = [];
  const humanContact = clean(intelligence.human_contact).toLowerCase();
  const responseHours = number(intelligence.response_hours);
  const contactAttempts = integer(intelligence.contact_attempts);
  const followUps = integer(intelligence.follow_ups);
  const channels = clean(intelligence.channels_used);
  const viewing = clean(intelligence.viewing_progression).toLowerCase();
  const viewingRank = VIEWING_RANK.get(viewing);
  const seller = clean(intelligence.seller_recognition).toLowerCase();
  const sellerRank = SELLER_RANK.get(seller);

  const responseFinding = firstFinding(storyFindings, (finding) => RESPONSE_FINDING_RE.test(findingText(finding)));
  if (responseFinding && humanContact === 'none' && contactAttempts === 0 && !channels) {
    candidates.push({
      ...fact('complete_miss', 'No human response or agency contact attempt was recorded during the observation window.', [findingSource(responseFinding), intelligenceSource('human_contact', 'contact_attempts', 'channels_used')]),
      finding_index: responseFinding.finding_index,
    });
  } else if (responseFinding && humanContact === 'none') {
    candidates.push({
      ...fact('no_human_response', 'No human response was recorded during the observation window.', [findingSource(responseFinding), intelligenceSource('human_contact')]),
      finding_index: responseFinding.finding_index,
    });
  } else if (responseFinding && humanContact === 'yes' && responseHours !== null && responseHours > SIXTEEN_HOURS) {
    candidates.push({
      ...fact('slow_human_response', 'The first human response was recorded more than 16 hours after the enquiry.', [findingSource(responseFinding), intelligenceSource('human_contact', 'response_hours')]),
      finding_index: responseFinding.finding_index,
    });
  }

  // This is a problem with the available EVIDENCE, not a claim that the
  // agency's communication itself was poor. It exists so an incomplete
  // record can be described honestly without converting unknown content into
  // a content-based failure. A timing problem from the same finding keeps
  // priority because it is independently known and commercially stronger.
  const incompleteFinding = firstFinding(storyFindings, (finding) => INCOMPLETE_CONTENT_RE.test(findingText(finding)));
  if (incompleteFinding) {
    candidates.push({
      ...fact('communication_record_incomplete', 'The available communication record is incomplete.', [findingSource(incompleteFinding)]),
      finding_index: incompleteFinding.finding_index,
    });
  }

  // Missing or truncated communication content cannot prove a content-based
  // negative. Timing and deterministic attempt counts above remain usable.
  if (!contentUncertain) {
    const sellerFinding = sellerDeclared
      ? firstFinding(storyFindings, (finding) => SELLER_FINDING_RE.test(findingText(finding)))
      : null;
    if (sellerFinding && sellerRank === SELLER_RANK.get('none')) {
      candidates.push({
        ...fact('seller_not_recognised', 'The declared seller opportunity was not recognised.', [findingSource(sellerFinding), intelligenceSource('seller_recognition'), probeSource('enquiry_text')]),
        finding_index: sellerFinding.finding_index,
      });
    } else if (sellerFinding && sellerRank !== undefined && sellerRank > SELLER_RANK.get('none') && sellerRank < SELLER_RANK.get('valuation_offered')) {
      candidates.push({
        ...fact('seller_recognised_not_progressed', 'The declared seller opportunity was recognised but was not progressed to a valuation offer.', [findingSource(sellerFinding), intelligenceSource('seller_recognition'), probeSource('enquiry_text')]),
        finding_index: sellerFinding.finding_index,
      });
    }

    const progressionFinding = firstFinding(storyFindings, (finding) => BUYER_PROGRESSION_RE.test(findingText(finding)));
    if (progressionFinding && viewingRank !== undefined && viewingRank <= VIEWING_RANK.get('mentioned')) {
      candidates.push({
        ...fact('buyer_not_progressed', 'The buyer enquiry was not progressed to an invitation, availability request, offered slot or booking.', [findingSource(progressionFinding), intelligenceSource('viewing_progression')]),
        finding_index: progressionFinding.finding_index,
      });
    }

    const qualificationFinding = firstFinding(storyFindings, (finding) => BUYER_QUALIFICATION_RE.test(findingText(finding)));
    if (qualificationFinding && /\b(?:none|zero|not\s+(?:one|a|any))\b/i.test(findingText(qualificationFinding))) {
      candidates.push({
        ...fact('buyer_not_qualified', 'No buyer qualification was recorded.', [findingSource(qualificationFinding)]),
        finding_index: qualificationFinding.finding_index,
      });
    }
  }

  const followUpFinding = firstFinding(storyFindings, (finding) => FOLLOW_UP_RE.test(findingText(finding)));
  if (followUpFinding && humanContact === 'yes' && contactAttempts === 1 && followUps === 0) {
    candidates.push({
      ...fact('no_follow_up', 'One human contact attempt was recorded and no follow-up attempt was recorded.', [findingSource(followUpFinding), intelligenceSource('human_contact', 'contact_attempts', 'follow_ups')]),
      finding_index: followUpFinding.finding_index,
    });
  }

  return candidates
    .sort((a, b) => a.finding_index - b.finding_index || PROBLEM_PRIORITY.get(a.type) - PROBLEM_PRIORITY.get(b.type))
    .filter((candidate, index, all) => all.findIndex((item) => item.type === candidate.type) === index)
    // One primary problem per upstream finding. A single sentence may mention
    // timing, follow-up and progression, but turning each phrase into a
    // separate primary problem would crowd out the next independently ranked
    // DIAGNOSIS_FINDING and overstate how many distinct failures were found.
    .filter((candidate, index, all) => all.findIndex((item) => item.finding_index === candidate.finding_index) === index)
    .slice(0, 2)
    .map(({ finding_index: _findingIndex, ...selected }) => selected);
}

function selectConsequences({ positive, problems, sellerDeclared }) {
  const positiveTypes = new Set(positive.map((item) => item.type));
  const problemTypes = new Set(problems.map((item) => item.type));
  const consequences = [];

  const buyerStopped = ['complete_miss', 'no_human_response', 'buyer_not_progressed'].some((type) => problemTypes.has(type));
  const buyerWeak = buyerStopped || problemTypes.has('buyer_not_qualified');
  const sellerWeak = ['seller_not_recognised', 'seller_recognised_not_progressed', 'no_valuation_offer'].some((type) => problemTypes.has(type));
  const speedGood = positiveTypes.has('human_response_fast') || positiveTypes.has('human_response_within_16h');

  if (buyerStopped) {
    consequences.push(fact('buyer_received_no_further_progression', 'The buyer enquiry received no further recorded progression.', [{ derived_from: [...problemTypes].filter((type) => ['complete_miss', 'no_human_response', 'buyer_not_progressed'].includes(type)) }]));
  }
  if (sellerWeak) {
    consequences.push(fact('seller_opportunity_not_developed', 'The declared seller opportunity was not developed to a valuation offer.', [{ derived_from: [...problemTypes].filter((type) => ['seller_not_recognised', 'seller_recognised_not_progressed', 'no_valuation_offer'].includes(type)) }]));
  }
  if (speedGood && buyerWeak) {
    consequences.push(fact('response_speed_good_but_progression_weak', 'Response speed was within 16 hours, but the supported buyer progression or qualification remained weak.', [{ derived_from: [...positiveTypes, ...problemTypes].filter((type) => ['human_response_fast', 'human_response_within_16h', 'buyer_not_progressed', 'buyer_not_qualified'].includes(type)) }]));
  }
  if (sellerDeclared && buyerWeak && sellerWeak) {
    consequences.push(fact('two_opportunities_present_but_not_both_progressed', 'The enquiry contained buyer and declared seller opportunities, and the selected facts do not show both being progressed.', [{ derived_from: [...problemTypes].filter((type) => ['complete_miss', 'no_human_response', 'buyer_not_progressed', 'buyer_not_qualified', 'seller_not_recognised', 'seller_recognised_not_progressed'].includes(type)) }, probeSource('enquiry_text')]));
  }
  if (problemTypes.has('slow_human_response')) {
    consequences.push(fact('enquiry_waited_before_human_handling', 'The enquiry waited more than 16 hours before recorded human handling.', [{ derived_from: ['slow_human_response'] }]));
  }
  if (problemTypes.has('communication_record_incomplete')) {
    consequences.push(fact('communication_quality_not_determinable', 'Communication quality cannot be determined from the incomplete record.', [{ derived_from: ['communication_record_incomplete'] }]));
  }

  return consequences;
}

function selectSecondaryFacts({ contentFinding, consequences, problems, sellerDeclared }) {
  if (contentFinding) {
    const text = findingText(contentFinding);
    if (UNKNOWN_CONTENT_RE.test(text)) {
      return [fact('communication_content_unknown', 'The recorded communication has no available content or transcript; what was discussed is unknown.', [findingSource(contentFinding)])];
    }
    return [fact('communication_content_incomplete', 'The available communication record is incomplete; content beyond the recorded fragment is unknown.', [findingSource(contentFinding)])];
  }

  // When the seller consequence is the only commercial consequence, retain
  // the independently supported origin fact for Hook 2. This is not a new
  // seller angle: the seller problem already requires both a declaration in
  // PROBES.enquiry_text and a seller-specific DIAGNOSIS_FINDING. It merely
  // keeps that intent in its true provenance — the original enquiry.
  const problemTypes = new Set(problems.map((item) => item.type));
  const sellerProblem = problemTypes.has('seller_not_recognised')
    || problemTypes.has('seller_recognised_not_progressed');
  if (sellerDeclared && sellerProblem && consequences.length < 2) {
    return [fact('seller_intent_present_in_original_enquiry', 'Seller intent was already present in the original enquiry.', [{ derived_from: [...problemTypes].filter((type) => type.startsWith('seller_')) }, probeSource('enquiry_text')])];
  }
  return [];
}

export function selectPersonalisationFacts({ findings = [], intelligence = {}, probe = {} } = {}) {
  const supportedFindings = validFindings(findings);
  const positiveFindings = supportedFindings.filter((finding) => finding.finding_type === 'positive');
  const storyFindings = supportedFindings.filter((finding) => finding.finding_type !== 'positive');
  const sellerDeclared = hasSellerDeclaration(probe);
  const contentFinding = uncertainContentFinding(storyFindings);
  const positive = selectPositive({ positiveFindings, intelligence, sellerDeclared });
  const problems = selectProblemCandidates({
    storyFindings,
    intelligence,
    sellerDeclared,
    contentUncertain: Boolean(contentFinding),
  });
  const consequences = selectConsequences({ positive, problems, sellerDeclared });

  return {
    positive,
    problems,
    consequences,
    secondary_facts: selectSecondaryFacts({ contentFinding, consequences, problems, sellerDeclared }),
  };
}
