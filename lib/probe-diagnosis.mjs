// lib/probe-diagnosis.mjs — the ONE AI call that turns a closed, interpreted
// INTELLIGENCE row into a commercial diagnosis (V2 schema §4).
//
// Reads INTELLIGENCE only. Adds no new evidence, no counts, and never
// touches the A-H grade — lib/grading.mjs remains the sole, unchanged,
// objective speed/persistence measure (Source Master §10, §29: "A-H grade |
// Rules engine | Commercial methodology must be stable").
//
// The grade is supplied as deterministic context and is also used with the
// retained ordinals to derive handling_quality after the model returns.
//
// findings may legitimately be an empty array: a probe the evidence shows
// was handled well produces no forced problem. The deterministic guard below
// (findings that survive requireFindingHasEvidence) is the only non-AI logic
// here: a finding without its evidence, or evidence without its finding, is
// never written. Capped at FOUR PER PROBE, allocated by role rather than
// filled in order — see MAX_FINDINGS_PER_PROBE below for why four and which
// four. Diagnosis states what the evidence shows, it does not try to be
// exhaustive; Personalisation (downstream) is still the layer that judges
// which findings the email's beats are written from, so this module stops at
// "here are the genuine, evidence-backed findings that earn their place and
// why each matters," not "here is the one story."
//
// DIAGNOSIS.findings is the canonical structured record. New model output has
// two arrays: findings[{issue,evidence}] and
// positive_findings[{positive,evidence}]. Storage adds the legacy finding_type
// projection implicitly from the array, so historical readers and the
// DIAGNOSIS_FINDINGS fallback remain compatible without asking the model for
// compatibility metadata or duplicate prose.

import { callAi } from './ai-client.mjs';
// The existing Personalisation seller-price provenance guard, reused as-is.
// It stays where it is and keeps running downstream as the safety net; this
// module imports it so the SAME rule is enforced at source, where the bad
// claim was actually being born. Not redesigned, not copied.
import {
  stripEnquiryAddressAttribution,
  stripSellerPriceAttribution,
} from './probe-personalisation.mjs';
// THE FINDINGS LAYER OBEYS THE FACTUAL RULES ITSELF (contract rule 27).
// DIAGNOSIS_FINDINGS is what everything downstream is required to trust, so a
// false relationship written here is not something Personalisation is allowed
// to quietly paper over — the bad finding would still be sitting in the sheet,
// still authoritative. Same discipline as the seller-price strip above: the
// rule is enforced where the claim is born.
import { findingInventsProspectResponse, stripInventedProspectResponse } from './factual-relationships.mjs';
import { enquiryPeriodPhrase, rewriteInternalProspectLanguage } from './prospect-language.mjs';

// FOUR FINDINGS PER PROBE, SHAPED BY WHAT THE EMAIL ACTUALLY USES.
//
// Personalisation writes exactly three beats — a fair observation from a
// [POSITIVE], a main story from the strongest [PROBLEM]/[OPPORTUNITY], and an
// optional wider beat from a genuinely DIFFERENT problem or opportunity — so a
// sixth finding was never a sixth thing the agency got told. It was one more
// near-duplicate for the selection step to tell apart, and the more of those
// there were, the likelier two beats came out of the same underlying event.
//
// So the budget is four, allocated by ROLE rather than filled in order:
//   1 positive               — the fair observation
//   1 strongest problem/opportunity — the main story
//   1 wider commercial opportunity  — the wider beat, where one is evidenced
//   1 optional supporting problem   — only when materially different
// Fewer is a correct answer for every slot: nothing is invented to fill one.
// The two array caps below ARE that allocation (3 story + 1 positive), which
// is what makes the per-probe total structurally four.
const MAX_FINDINGS_PER_PROBE = 4;
const MAX_STORY_FINDINGS = 3;
// ONE. The email needs the STRONGEST genuine positive, not a catalogue: it
// writes a single fair observation and never reads a second positive, so a
// second one is only somewhere to pad.
const MAX_POSITIVE_FINDINGS = 1;
const PROBE_CONTACT_LOCALITY = 'Billericay';

// The retained semantic response is deliberately small: three story findings,
// one positive, six signals and three unresolved questions.
export const DIAGNOSIS_MAX_TOKENS = 1200;

const TOOL = {
  name: 'record_probe_diagnosis',
  description: 'Record the commercial diagnosis for one probe, derived strictly from its Intelligence evidence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'positive_findings', 'enquiry_signals', 'unresolved_context'],
    properties: {
      findings: {
        type: 'array',
        description: 'The genuine, DISTINCT problems and evidence-supported opportunities — 0 to 3 items. Consolidate findings that describe the same underlying issue. Unknown context is not an opportunity. A seller declaration alone is never a valuation opportunity. Empty is correct for strong handling.',
        maxItems: MAX_STORY_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['issue', 'evidence'],
          properties: {
            issue: { type: 'string', description: 'One distinct, commercially damaging thing the evidence shows — stated as its own issue, not folded into another.' },
            evidence: { type: 'string', description: 'The specific fact or quote this finding rests on (a quote, a number of hours, a count of questions, an explicit absence). Never empty when finding is non-empty.' },
          },
        },
      },
      positive_findings: {
        type: 'array',
        description: 'The single strongest genuine thing the agency actually did well — 0 or 1 items, never more. Each item is one specific act with its own evidence. Empty array only when nothing positive is genuinely evidenced; never invent one to fill the slot.',
        maxItems: MAX_POSITIVE_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['positive', 'evidence'],
          properties: {
            positive: { type: 'string', description: 'One specific thing the agency did well, stated plainly — e.g. "The team followed up quickly." Not a summary of the whole probe, not hedged, and never a compliment the evidence does not support.' },
            evidence: { type: 'string', description: 'The specific fact this positive rests on — e.g. "Three attempts across phone and email within one day." Never empty.' },
          },
        },
      },
      enquiry_signals: {
        type: 'array', maxItems: 6,
        description: '4–6 concise facts that materially help someone understand this enquiry. Facts only; no inference or verdict.',
        items: {
          type: 'object', additionalProperties: false,
          required: ['label', 'value', 'context'],
          properties: {
            label: { type: 'string' }, value: { type: 'string' }, context: { type: 'string' },
          },
        },
      },
      unresolved_context: {
        type: 'array', maxItems: 3,
        description: '0–3 important questions the evidence does not answer. Fewer is better. Exclude anything already established, overlapping questions about the same unknown, and premature detail questions.',
        items: {
          type: 'object', additionalProperties: false,
          required: ['question', 'why_it_matters'],
          properties: { question: { type: 'string' }, why_it_matters: { type: 'string' } },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `Record only the commercially meaningful facts supported by this completed enquiry record.

Hard rules:
1. Do not force an issue. Strong handling may produce an empty findings array. Unknown context belongs in unresolved_context, not findings. Never manufacture a problem to fill the response.
2. Every issue and positive needs its own non-empty evidence. Keep issues distinct, consolidate overlaps, return the most commercially important first, and never exceed three issues plus one positive.
3. A seller declaration is a signal only. It does not prove a viable valuation, instruction, seller-property address, location, value, or dependency between purchase and sale. Declaration plus no clarification is unresolved context, not valuation-opportunity language. Any seller or valuation issue must itself contain evidence beyond the declaration.
4. The prospect never replies. State only what the original enquiry declared and what the agency did, asked or failed to ask. Never say the prospect confirmed, replied, answered, agreed or came back.
5. Keep the evidence's certainty. A property to sell is a potential instruction, never an instruction already won. A call without a transcript has unknown content; do not claim what was or was not said in it.
6. The listed property's address and asking price belong only to the buyer enquiry. Never attribute either to a property the prospect may sell. The supplied Billericay contact address is not a seller-property address unless the communications explicitly establish that relationship.
7. positive_findings contains at most the single strongest genuine act. If there was human contact, use the strongest evidenced reply, acknowledgement, call, question, follow-up, correct name/property reference or progression. If nothing positive is evidenced, return an empty array.
8. enquiry_signals contains 4–6 concise facts only, with no inference or verdict. unresolved_context contains at most three unanswered, non-overlapping questions. Exclude anything already established and any premature valuation or instruction step.
9. Use ordinary UK English. Avoid internal terms such as observation window, probe, diagnosis, intelligence row, classification or pipeline.`;

function buildPrompt(intelligence, probe) {
  return [
    // PROVENANCE, STATED. The bare `(£450,000)` this line used to carry read
    // as "a price belonging to this probe", and the model then spent it on
    // whichever opportunity it was writing about — including the seller one,
    // which this figure says nothing about. Naming what the figure IS is half
    // the fix; SYSTEM_PROMPT rule 9 forbids the seller-side use, and
    // diagnoseProbe() strips it deterministically if the model does it anyway.
    `Property the prospect enquired about AS A BUYER: ${probe?.property_address || 'unknown'}`,
    `Asking price of THAT buyer-side property (the only figure on file, and NOT a value for anything the prospect has to sell): ${probe?.property_price || 'price unknown'}`,
    `Contact address locality supplied with the enquiry: ${PROBE_CONTACT_LOCALITY} (relationship to any property being sold: UNKNOWN unless communications establish it)`,
    `Original enquiry text: ${probe?.enquiry_text || '(none)'}`,
    `Enquiry review period: ${enquiryPeriodPhrase(probe, { firstPerson: false })}`,
    `Grade (reference only, do not template from it): ${intelligence.grade || 'unknown'} — ${intelligence.grade_reason || ''}`,
    `Human contact: ${intelligence.human_contact || 'unknown'}`,
    `Response time: ${intelligence.response_hours !== '' && intelligence.response_hours != null ? `${intelligence.response_hours} hours` : 'no human contact'}`,
    `Contact attempts: ${intelligence.contact_attempts ?? 0}, follow-ups after the first: ${intelligence.follow_ups ?? 0}`,
    `Channels used: ${intelligence.channels_used || 'none'}`,
    `Viewing progression: ${intelligence.viewing_progression || 'none'}`,
    `Validated buyer questions asked: ${intelligence.buyer_questions_asked || 'none'}`,
    `Seller/vendor recognition: ${intelligence.seller_recognition === '' ? 'n/a — no property declared for sale' : (intelligence.seller_recognition || 'none')}`,
  ].join('\n');
}

// Guards against a finding with no evidence, or evidence with no finding —
// the one piece of non-AI logic in this module. Also drops anything past the
// cap, in case the model over-returns despite the schema.
//
// type and textField are supplied by the array the item belongs to. The model
// no longer types findings: story findings are problems; positive findings are
// positives. This keeps finding_type only in the historical storage projection.
function sanitizeFindings(findings, { max, forcedType, probe, intelligence } = {}) {
  return (Array.isArray(findings) ? findings : [])
    .map((f) => {
      const textField = forcedType === 'positive' ? 'positive' : 'issue';
      const legacyType = String(f?.finding_type || '').trim().toLowerCase();
      return {
        finding_type: forcedType || (f?.issue == null && legacyType === 'opportunity' ? 'opportunity' : 'problem'),
        // Seller-side price attribution removed AT SOURCE, before the finding
        // is ever persisted to DIAGNOSIS_FINDINGS. Surgical, not sentence-
        // level: only the price reference in a seller clause goes, so an
        // evidenced finding is never emptied (and never dropped by the
        // finding/evidence filter below) by this guard.
        finding: stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(f?.[textField] || f?.finding || '').trim()), probe?.property_address),
        evidence: stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(f?.evidence || '').trim()), probe?.property_address),
        significance_note: f?.[textField] == null
          ? stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(f?.significance_note || '').trim()), probe?.property_address)
          : '',
      };
    })
    // INVENTED PROSPECT RESPONSES, REMOVED AT SOURCE. prb_mt0puwtj_1r7vrh
    // shipped a finding reading "... once he confirmed it" when the evidence
    // showed only that the agency ASKED whether he was selling. The prospect
    // confirmed nothing — the probe never replies — so that clause was a
    // relationship nobody evidenced, persisted as authoritative fact.
    //
    // Surgical, for the same reason the price strip is: the finding around it
    // is usually a REAL problem ("they asked for something the enquiry had
    // already told them"), and deleting the row would throw that away with the
    // false clause. Only the invented clause goes; if nothing survives, the
    // finding/evidence gate below drops the row as it always has.
    .map((f) => (findingInventsProspectResponse(f)
      ? {
        ...f,
        finding: stripInventedProspectResponse(f.finding),
        significance_note: stripInventedProspectResponse(f.significance_note),
      }
      : f))
    .filter((f) => {
      if (!f.finding || !f.evidence) return false;
      // With finding_type removed from the model response, the seller/valuation
      // safety gate applies to EVERY story finding. A declaration plus an
      // absent valuation is not enough; the evidence must establish more.
      if (forcedType !== 'positive' && /seller|vendor|valuation|property to sell/i.test(`${f.finding} ${f.evidence}`)) {
        const explicitSupport = /requested a valuation|asked for a valuation|confirmed.*(?:sale|selling)|property.*(?:in|within).*(?:area|patch)|valuation (?:was|had been) (?:requested|discussed)/i.test(`${f.finding} ${f.evidence}`);
        if (!explicitSupport) return false;
      }
      return true;
    })
    .slice(0, max);
}

function cleanStructuredText(value, probe) {
  return stripInventedProspectResponse(
    stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(value || '').trim()), probe?.property_address),
  );
}

function cleanProspectText(value, probe) {
  return rewriteInternalProspectLanguage(cleanStructuredText(value, probe), {
    periodPhrase: enquiryPeriodPhrase(probe, { firstPerson: false }),
  });
}

function sanitizeObjects(items, fields, max, probe) {
  return (Array.isArray(items) ? items : []).slice(0, max).map((item) => {
    const out = {};
    for (const field of fields) out[field] = cleanStructuredText(item?.[field], probe);
    return out;
  }).filter((item) => fields[0] && item[fields[0]]);
}

function questionAlreadyAnswered(question, intelligence, probe) {
  const text = String(question || '').toLowerCase();
  const enquiry = String(probe?.enquiry_text || '').toLowerCase();
  // Asking is not answering: the probe deliberately does not reply. Only an
  // answer already present in the original enquiry or an objective completed
  // progression state closes an unknown.
  if (/time|when|timescale/.test(text) && /(?:within|in|over|next)\s+\d+\s+(?:day|week|month)|by\s+(?:spring|summer|autumn|winter|christmas)/.test(enquiry)) return true;
  if (/finance|mortgage|budget/.test(text) && /(?:budget|mortgage|cash buyer|agreement in principle)\s*(?:is|of|for|:)/.test(enquiry)) return true;
  if (/depend|chain|selling first/.test(text) && /(?:does not|doesn't|will not|won't) depend on (?:a |the )?sale|sale agreed/.test(enquiry)) return true;
  if (/billericay|property.*sell|sale/.test(text)
      && (/(?:billericay[^.!?]{0,40}(?:is|being) (?:the |my )?property (?:i am |i'm )?(?:selling|planning to sell))/.test(enquiry)
        || /(?:not|isn't|is not)[^.!?]{0,20}(?:the )?billericay (?:contact )?address|billericay (?:contact )?address[^.!?]{0,20}(?:is not|isn't)[^.!?]{0,20}(?:property|home|house|flat).*sell/.test(enquiry))) return true;
  if (/view|availability/.test(text) && ['availability_requested', 'slot_offered', 'booked'].includes(String(intelligence?.viewing_progression || ''))) return true;
  return false;
}

function unresolvedTopic(question) {
  const text = String(question || '').toLowerCase();
  if (/billericay|which property|property (?:is|being).*(?:sold|sell)|address.*property.*sell/.test(text)) return 'seller_property_identity';
  if (/condition|location|where.*property.*sell|valuation|market appraisal|instruction/.test(text)) return 'seller_property_detail';
  if (/depend|chain|selling first/.test(text)) return 'sale_dependency';
  if (/time|when|timescale/.test(text)) return 'timescale';
  if (/view|availability/.test(text)) return 'viewing';
  if (/finance|mortgage|budget|cash/.test(text)) return 'finance';
  return text.replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((token) => token.length > 4).slice(0, 3).join('_');
}

function sanitizeUnresolvedContext(items, intelligence, probe) {
  const cleaned = sanitizeObjects(items, ['question', 'why_it_matters'], 6, probe)
    .map((item) => ({
      question: cleanProspectText(item.question, probe),
      why_it_matters: cleanProspectText(item.why_it_matters, probe),
    }))
    .filter((item) => !questionAlreadyAnswered(item.question, intelligence, probe))
    .filter((item) => !/\b(?:valu(?:e|ed|ing|ation)|market appraisal|instruction|property condition|listed|brought to market|sale progress)\b/i.test(`${item.question} ${item.why_it_matters}`));
  const hasSellerIdentity = cleaned.some((item) => unresolvedTopic(item.question) === 'seller_property_identity');
  const seen = new Set();
  return cleaned.filter((item) => {
    const topic = unresolvedTopic(item.question);
    if (hasSellerIdentity && topic === 'seller_property_detail') return false;
    if (seen.has(topic)) return false;
    seen.add(topic);
    return true;
  }).slice(0, 3);
}

const GENERIC_ACTION_RE = /\b(?:flag|mark|log|tag|prioriti[sz]e|high priority|hot lead|escalat|dual-sided|crm)\b/i;
const PREMATURE_SELLER_ACTION_RE = /\b(?:progress (?:the )?seller opportunity|valu(?:e|ed|ing|ation)|market appraisal|instruction|property condition|listed|brought to market|sale progress)\b/i;

function sanitizeRecommendedActions(items, probe, unresolved = []) {
  const seen = new Set();
  return sanitizeObjects(items, ['title', 'detail'], 6, probe)
    .map((item) => ({
      title: cleanProspectText(item.title, probe),
      detail: cleanProspectText(item.detail, probe),
    }))
    .filter((item) => !GENERIC_ACTION_RE.test(`${item.title} ${item.detail}`))
    .filter((item) => !PREMATURE_SELLER_ACTION_RE.test(`${item.title} ${item.detail}`))
    .map((item) => {
      if (unresolved.some((question) => unresolvedTopic(question.question) === 'seller_property_identity')
          && unresolvedTopic(`${item.title} ${item.detail}`) === 'seller_property_identity') {
        return {
          title: 'Clarify the seller position',
          detail: 'Establish whether the Billericay address is the property being sold and whether the sale is relevant to the move.',
        };
      }
      return item;
    })
    .filter((item) => {
      const topic = unresolvedTopic(`${item.title} ${item.detail}`);
      if (seen.has(topic)) return false;
      seen.add(topic);
      return true;
    })
    .slice(0, 3);
}

function deriveHandlingSummary(intelligence, probe) {
  const period = enquiryPeriodPhrase(probe, { firstPerson: false });
  if (String(intelligence?.human_contact || '').toLowerCase() === 'none') {
    const attempts = Number.parseInt(intelligence?.contact_attempts, 10);
    if (!Number.isFinite(attempts) || attempts === 0) {
      return `No human contact was recorded ${period}; no response or follow-up attempt was made.`;
    }
  }
  const responseHours = Number.parseFloat(intelligence?.response_hours);
  const followUps = Number.parseInt(intelligence?.follow_ups, 10);
  const viewing = String(intelligence?.viewing_progression || '').toLowerCase();
  const qualification = String(intelligence?.buyer_qualification || '').toLowerCase();
  const sellerRecognition = String(intelligence?.seller_recognition || '').toLowerCase();
  const parts = [];
  if (Number.isFinite(responseHours)) {
    const minutes = Math.max(1, Math.round(responseHours * 60));
    if (minutes < 60) parts.push(`The team responded within ${minutes} minute${minutes === 1 ? '' : 's'}`);
    else if (minutes < 24 * 60) {
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      parts.push(`The team responded within ${hours} hour${hours === 1 ? '' : 's'}${remainder ? ` ${remainder} minutes` : ''}`);
    } else if (minutes < 48 * 60) parts.push('The first human contact came the next day');
    else parts.push(`The first human contact came about ${Math.round(minutes / 1440)} days later`);
  } else parts.push('The team made human contact');
  if (Number.isFinite(followUps) && followUps > 0) parts.push(`followed up ${followUps === 1 ? 'once' : followUps === 2 ? 'twice' : `${followUps} times`}`);
  if (['availability_requested', 'slot_offered', 'booked'].includes(viewing)) parts.push('gave the viewing a clear next step');
  if (['standard', 'thorough'].includes(qualification)) parts.push('asked useful questions about the buyer\'s position');
  if (qualification === 'none') parts.push('asked no recorded questions about the buyer\'s position');
  if (['asked_position', 'acknowledged', 'valuation_offered', 'valuation_booked'].includes(sellerRecognition)) parts.push('recognised the seller context');
  return `${parts.join(', ')}.`;
}

function deriveHandlingQuality(storyFindings, intelligence) {
  const grade = String(intelligence?.grade || '').trim().toUpperCase();
  const viewing = ['none', 'mentioned', 'invited', 'availability_requested', 'slot_offered', 'booked']
    .indexOf(String(intelligence?.viewing_progression || '').trim().toLowerCase());
  const qualification = ['none', 'minimal', 'standard', 'thorough']
    .indexOf(String(intelligence?.buyer_qualification || '').trim().toLowerCase());
  const seller = ['none', 'asked_position', 'acknowledged', 'valuation_offered', 'valuation_booked']
    .indexOf(String(intelligence?.seller_recognition || '').trim().toLowerCase());
  if (['G', 'H'].includes(grade)) return 'weak';
  if (storyFindings.length === 0) {
    return ['A', 'B', 'C', 'D'].includes(grade) && viewing >= 3 && qualification >= 2
      ? 'strong'
      : 'mixed';
  }
  if (storyFindings.length >= 2) return 'weak';
  if (['E', 'F'].includes(grade) && viewing <= 1 && qualification <= 1 && seller <= 0) return 'weak';
  return 'mixed';
}

// intelligence: an INTELLIGENCE row (observation_status must already be
// 'closed' — caller's responsibility). probe: the PROBES row, for property
// context in the prompt.
// -> { findings (JSON string, [] when the evidence shows no problem),
//      strengths, missed_opportunities, commercial_implication,
//      novus_opportunity, diagnosis_summary }
export async function diagnoseProbe(intelligence, probe) {
  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(intelligence, probe),
    tool: TOOL,
    purpose: 'diagnosis',
    maxTokens: DIAGNOSIS_MAX_TOKENS,
  });
  return sanitizeDiagnosisResult(result, intelligence, probe);
}

// THE DETERMINISTIC HALF OF DIAGNOSIS, SEPARATED FROM THE CALL THAT FEEDS IT.
//
// Every factual guard this module owns lives here: the seller-price and
// enquiry-address provenance strips, the invented-prospect-response strip, the
// finding/evidence gate, the four-per-probe cap, the "a seller declaration is
// not a valuation opportunity" opportunity gate, the novus_opportunity
// downgrade, the unresolved-context and recommended-action sanitisers, and the
// handling-summary rewrite.
//
// It is exported because lib/probe-assessment.mjs — the ONE merged
// interpretation+assessment call — must produce a DIAGNOSIS row that is
// byte-for-byte as safe as one produced here. Sharing the function is what
// makes that true by construction instead of by review: there is exactly one
// implementation of these rules, and both callers go through it.
export function sanitizeDiagnosisResult(result, intelligence, probe) {
  // ONE ordered list, problems/opportunities first so finding_index 1 still
  // means "most commercially damaging" and every index already written to a
  // sheet keeps the meaning it had. Positives are appended after them.
  const storyFindings = sanitizeFindings(result.findings, { max: MAX_STORY_FINDINGS, probe, intelligence });
  const positiveFindings = sanitizeFindings(result.positive_findings, { max: MAX_POSITIVE_FINDINGS, forcedType: 'positive', probe, intelligence });
  // The per-probe cap, stated once rather than left implied by the two array
  // caps that already add up to it — a model that over-returns on both arrays
  // can never put a fifth row into DIAGNOSIS_FINDINGS.
  const findings = [...storyFindings, ...positiveFindings].slice(0, MAX_FINDINGS_PER_PROBE);
  const novusOpportunity = storyFindings.length ? 'Core (front desk)' : 'None evidenced';
  const unresolvedContext = sanitizeUnresolvedContext(result.unresolved_context, intelligence, probe)
    .map((item) => (unresolvedTopic(item.question) === 'seller_property_identity'
      ? { ...item, why_it_matters: 'This must be clear before deciding whether the sale is relevant to the move.' }
      : item));

  // The same provenance rule on the prose DIAGNOSIS fields. sanitizeFindings()
  // has already applied it to every findings row above.
  return {
    findings: JSON.stringify(findings),
    enquiry_signals: JSON.stringify(sanitizeObjects(result.enquiry_signals, ['label', 'value', 'context'], 6, probe)
      .map((item) => ({ ...item, label: cleanProspectText(item.label, probe), value: cleanProspectText(item.value, probe), context: cleanProspectText(item.context, probe) }))),
    unresolved_context: JSON.stringify(unresolvedContext),
    handling_summary: deriveHandlingSummary(intelligence, probe),
    handling_quality: deriveHandlingQuality(storyFindings, intelligence),
    novus_opportunity: novusOpportunity,
    diagnosis_summary: 'assessed',
  };
}

// Shared with lib/probe-personalisation.mjs so both sides agree on the
// stored shape: a DIAGNOSIS.findings cell is either '', a bare '[]', or a
// JSON array of { finding_type, finding, evidence, significance_note }.
// A legacy cell written before finding_type existed reads back untyped, and
// lib/diagnosis-findings.mjs's normaliseFindingType() defaults it to
// 'problem'. Never throws — unparsable content reads back as no findings.
export function parseDiagnosisFindings(diagnosis) {
  const raw = diagnosis?.findings;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Test-only surface, same shape as lib/probe-personalisation.mjs's: the brief
// the model is actually given, so the per-probe finding budget and the
// consolidate-don't-duplicate instruction are regression-tested rather than
// assumed to still be in the prompt.
export { buildPrompt as buildDiagnosisPrompt };

export const _internal = {
  TOOL, SYSTEM_PROMPT,
  MAX_FINDINGS_PER_PROBE, MAX_STORY_FINDINGS, MAX_POSITIVE_FINDINGS,
  sanitizeFindings, sanitizeObjects, questionAlreadyAnswered, unresolvedTopic,
  sanitizeUnresolvedContext, sanitizeRecommendedActions,
  deriveHandlingSummary, deriveHandlingQuality,
};
