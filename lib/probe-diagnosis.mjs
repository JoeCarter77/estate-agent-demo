// lib/probe-diagnosis.mjs — the ONE AI call that turns a closed, interpreted
// INTELLIGENCE row into a commercial diagnosis (V2 schema §4).
//
// Reads INTELLIGENCE only. Adds no new evidence, no counts, and never
// touches the A-H grade — lib/grading.mjs remains the sole, unchanged,
// objective speed/persistence measure (Source Master §10, §29: "A-H grade |
// Rules engine | Commercial methodology must be stable").
//
// The grade is passed to the model purely as reference context ("this is
// what the timing/persistence rules already concluded") — it is explicitly
// instructed NOT to select or template a diagnosis off the grade letter.
// Two probes graded identically must be able to produce entirely different
// diagnoses, because the diagnosis is generated from the INTELLIGENCE
// evidence fields (viewing/buyer/seller behaviour, communication quality,
// did_well/missed/evidence), not looked up from a grade->paragraph table.
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
// WHICH OF THIS MODULE'S OUTPUTS ARE AUTHORITATIVE. Two of them:
// `findings`/`positive_findings` (persisted to DIAGNOSIS_FINDINGS, the single
// authoritative commercial interpretation layer) and `novus_opportunity` (a
// three-value enum that routes the demo's hero journey). The four PROSE
// fields — `strengths`, `missed_opportunities`, `commercial_implication`,
// `diagnosis_summary` — are NON-AUTHORITATIVE DOWNSTREAM. Nothing reads their
// text: they exist for the DIAGNOSIS tab and the sales call, and
// `diagnosis_summary` additionally carries the structural "diagnosed and
// frozen" flag, which is why it must stay non-blank and why none of the four
// is dropped. They are kept deliberately and deprecated in place rather than
// migrated away; see docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §4.
//
// The consequence worth stating plainly: a fact that exists only in this
// prose cannot reach a prospect. If it matters commercially, it has to be a
// FINDING, with its own evidence.
//
// POSITIVES ARE FINDINGS TOO, NOW. `strengths` remains on the DIAGNOSIS row
// (nothing downstream of Diagnosis lost a field), but it is no longer the
// SOURCE the email's fair observation is drawn from. Personalisation reads
// only DIAGNOSIS_FINDINGS, so a strength that exists only as a paragraph is a
// strength the email cannot use — the model therefore also returns
// positive_findings[], each one a SEPARATE, individually evidence-backed
// thing the agency did well, in exactly the same
// finding/evidence/significance_note shape as a problem. They are NOT the
// strengths paragraph chopped up: one positive is one specific act
// ("the team followed up quickly"), with its own evidence ("three attempts
// across phone and email within one day") and its own significance note.
//
// The two arrays are persisted into ONE ordered findings list, problems and
// opportunities FIRST (so finding_index 1 stays "most commercially damaging"
// exactly as before, and every already-written index keeps its meaning),
// positives appended after them. Each row carries its finding_type.

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
import { enquiryPeriodPhrase, rewriteInternalProspectLanguage, wordCount } from './prospect-language.mjs';

const NOVUS_OPPORTUNITIES = ['Core (front desk)', 'Growth (valuation list / seller conversion)', 'None evidenced'];

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
const STORY_FINDING_TYPES = ['problem', 'opportunity'];
const HANDLING_QUALITIES = ['weak', 'mixed', 'strong'];
const PROBE_CONTACT_LOCALITY = 'Billericay';

const TOOL = {
  name: 'record_probe_diagnosis',
  description: 'Record the commercial diagnosis for one probe, derived strictly from its Intelligence evidence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'findings', 'positive_findings', 'enquiry_signals', 'unresolved_context',
      'recommended_actions', 'handling_summary', 'handling_quality',
      'strengths', 'missed_opportunities', 'commercial_implication',
      'novus_opportunity', 'diagnosis_summary',
    ],
    properties: {
      findings: {
        type: 'array',
        description: 'The genuine, DISTINCT problems and evidence-supported opportunities — 0 to 3 items. Consolidate findings that describe the same underlying issue. Unknown context is not an opportunity. A seller declaration alone is never a valuation opportunity. Empty is correct for strong handling.',
        maxItems: MAX_STORY_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['finding_type', 'finding', 'evidence', 'significance_note'],
          properties: {
            finding_type: {
              type: 'string',
              enum: STORY_FINDING_TYPES,
              description: "'problem' when evidence shows poor/incomplete handling; 'opportunity' only when commercial potential is genuinely established by evidence. Unknown context is neither.",
            },
            finding: { type: 'string', description: 'One distinct, commercially damaging thing the evidence shows — stated as its own finding, not folded into another.' },
            evidence: { type: 'string', description: 'The specific fact or quote this finding rests on (a quote, a number of hours, a count of questions, an explicit absence). Never empty when finding is non-empty.' },
            significance_note: { type: 'string', description: 'Why this finding matters commercially and whether this agency would likely recognise it themselves without NOVUS — the raw material a later step uses to judge how commercially consequential this finding is, not a sentence about the whole probe.' },
          },
        },
      },
      positive_findings: {
        type: 'array',
        description: 'The single strongest genuine thing the agency actually DID WELL — 0 or 1 items, never more. This is NOT the strengths paragraph split up: each item is ONE specific act, with its own evidence and its own reason it matters. Empty array ONLY when there was no human contact at all, or when nothing positive is genuinely evidenced — never invent one to fill the slot. If any human replied, called, acknowledged the enquiry, asked a question, followed up or used the name/property correctly, the strongest of those is a real positive and belongs here.',
        maxItems: MAX_POSITIVE_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['finding', 'evidence', 'significance_note'],
          properties: {
            finding: { type: 'string', description: 'One specific thing the agency did well, stated plainly — e.g. "The team followed up quickly." Not a summary of the whole probe, not hedged, and never a compliment the evidence does not support.' },
            evidence: { type: 'string', description: 'The specific fact this positive rests on — e.g. "Three attempts across phone and email within one day." Never empty.' },
            significance_note: { type: 'string', description: 'Why this positive matters — e.g. "Shows strong persistence." One short sentence.' },
          },
        },
      },
      enquiry_signals: {
        type: 'array', maxItems: 6,
        description: '4–6 concise facts that materially help someone understand this enquiry. Facts only; no inference or verdict.',
        items: {
          type: 'object', additionalProperties: false,
          required: ['label', 'value', 'context', 'source_type'],
          properties: {
            label: { type: 'string' }, value: { type: 'string' }, context: { type: 'string' },
            source_type: { type: 'string', enum: ['probe', 'intelligence', 'communication'] },
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
      recommended_actions: {
        type: 'array', maxItems: 3,
        description: '0–3 minimal next actions that materially change what happens next. Fewer is better; never pad with generic CRM, priority, escalation or dual-sided-lead housekeeping.',
        items: {
          type: 'object', additionalProperties: false,
          required: ['title', 'detail'],
          properties: { title: { type: 'string' }, detail: { type: 'string' } },
        },
      },
      handling_summary: { type: 'string', description: 'One short factual summary of how this specific enquiry was handled. It may be negative, mixed, good or excellent.' },
      handling_quality: { type: 'string', enum: HANDLING_QUALITIES },
      strengths: { type: 'string', description: 'NON-AUTHORITATIVE — internal/sales-call prose for the DIAGNOSIS row only. Nothing downstream reads it: the outreach email and the demo are built from positive_findings, never from this paragraph, so a genuine positive left only here is one that can never be used. What the agency did well, evidence-backed.' },
      missed_opportunities: { type: 'string', description: 'NON-AUTHORITATIVE internal prose. State only evidence-backed incomplete handling or genuine opportunity. An unknown seller position is not a missed valuation. Empty is valid.' },
      commercial_implication: { type: 'string', description: 'NON-AUTHORITATIVE internal prose. Explain why the evidence is worth examining without invented loss, fees, value or automatic valuation claims.' },
      novus_opportunity: { type: 'string', enum: NOVUS_OPPORTUNITIES, description: 'The one STRUCTURED field on this row that is read downstream: it routes the demo hero journey for a probe with no genuine problem. Not prose — one of the three listed values.' },
      diagnosis_summary: { type: 'string', description: 'NON-AUTHORITATIVE AS PROSE — but it must never be empty: a non-blank value is the pipeline\'s "this probe is diagnosed and frozen" flag, and the text itself is read by nobody downstream. Two or three sentences a salesperson could say on a call.' },
    },
  },
};

const SYSTEM_PROMPT = `You are writing the commercial diagnosis for one NOVUS probe, from its Intelligence evidence only.

Hard rules:
1. The A-H grade you are given is an objective, unchanged speed/persistence measurement — reference it if useful, but NEVER select or template your answer from the grade letter. Two probes with the same grade must be able to produce completely different diagnoses if their evidence differs, and two probes with different grades can share a finding if the evidence says so.
2. Do not force a finding. Strong handling with no material problem may produce an empty findings array. Unknown context belongs in unresolved_context, not findings. A strong result is valid and must not acquire a fake "but".
3. Every finding needs its own evidence field non-empty; never state a finding you cannot back with a specific fact from the Intelligence row (a quote, a number of hours, a count of questions, an explicit absence like "no valuation was ever offered"). Each finding must be genuinely distinct — do not split one observation into two findings, and do not repeat the same problem worded differently. Where two candidate findings are really the same event or the same underlying issue, CONSOLIDATE them into the single stronger statement; distinct and evidenced beats complete.
4. commercial_implication must contain something specific to THIS agency and THIS probe — not a sentence that could be pasted onto any other agency's diagnosis.
5. Separate KNOWN, UNKNOWN, HANDLING and NEXT. A seller declaration is known. Whether it is commercially actionable, in-area, linked to the supplied Billericay contact address, or required before purchase is unknown unless the evidence establishes it. Never turn those unknowns into a valuation opportunity.
6. FOUR FINDINGS PER PROBE, MAXIMUM, AND THEY HAVE ROLES. You are not cataloguing everything that went wrong. A later step writes one short email from these findings, and it uses at most three of them, so return only the findings that earn their place, most commercially damaging first:
   - findings[0] — THE MAIN STORY: the single most commercially important or damaging thing the evidence shows.
   - findings[1] — an optional second, genuinely distinct problem or evidence-supported opportunity. Do not reserve this slot for seller/valuation language.
   - findings[2] — ONE OPTIONAL SUPPORTING PROBLEM, only when it is materially different from findings[0] and adds something the email could not otherwise say.
   - positive_findings[0] — the strongest genuine thing they did well (rule 8).
   Every one of these slots may legitimately be empty, and two or three findings in total is a perfectly good answer. Never invent a wider opportunity, a supporting problem or a positive to fill a slot, and never pad by returning the same issue twice in different words. Prefer the stronger of two overlapping findings to both.
7. TYPE EVERY FINDING. 'problem' = something the evidence shows was handled poorly, left incomplete or unnecessarily stalled. 'opportunity' = commercial potential genuinely supported by evidence. A seller declaration plus no clarification is usually unresolved seller context, NOT an opportunity and never proof that a valuation should have been offered.
8. POSITIVES ARE STRUCTURED FINDINGS, NOT A PARAGRAPH — AND THERE IS ROOM FOR EXACTLY ONE. positive_findings is the ONLY place a later step can read what the agency did well from, so a positive that exists only inside your strengths prose is one the outreach email can never use. Return the SINGLE strongest one: it is ONE specific act with its own evidence and its own one-line reason it matters — for example: finding "The team followed up quickly."; evidence "Three attempts across phone and email within one day."; significance_note "Shows strong persistence." Do not restate the whole strengths paragraph as one item, never return more than one, and never write a positive the evidence does not support — an empty array is the right answer when nothing positive is genuinely evidenced. If there was any human contact at all, there is almost always at least one genuine positive: they replied, they acknowledged it, they called, they asked a question, they followed up, they used the name or the property correctly. If there was NO human contact, positive_findings must be empty.

9. THE PROSPECT NEVER REPLIES, SO NEVER WRITE A FINDING IN WHICH THEY DID. The enquiry is a probe: one message is sent and then nothing further, whatever the agency does. So you may state what the ENQUIRY declared ("the enquiry said he had a property to sell") and what the AGENCY did, asked or failed to ask — but never that the enquirer confirmed, replied, answered, agreed or came back, and never a sequence built on one ("the agency asked whether he was selling ONCE HE CONFIRMED IT"). Where the agency asked about something the enquiry had already stated, that IS the finding, and the honest wording is the stronger one: "the agency asked whether he was selling, despite the enquiry having already declared it". The same applies to timing: a declaration made in the original enquiry stays in the original enquiry — it was not made on a call, in a reply, or at any later moment.

10. KEEP THE EVIDENCE'S LEVEL OF CERTAINTY. A property someone says they have to sell is a POTENTIAL instruction, never an instruction: an instruction is business the agency has actually won. A call with no transcript means the content is UNKNOWN, which is not the same as the call containing nothing — write "no recorded content shows the seller opportunity was addressed", never "the call never mentioned it". Do not rank the two opportunities against each other ("the more valuable seller side"): nothing on file measures one against the other. Do not state what anyone outside the agency knew or believed.

11. NEVER PRICE SELLER CONTEXT. The only figure supplied is the asking price of the listed property enquired about AS A BUYER. There is no seller-property value. Do not attach that figure to a seller, valuation, instruction or property to sell. You may use it only for the buyer enquiry itself. A money-free seller statement must still obey rule 7: call it an opportunity only when evidence genuinely establishes one.
12. STRUCTURED READING. enquiry_signals contains only 4–6 meaningful facts and keeps every label, value and context glanceable. unresolved_context contains only questions that remain unanswered, maximum 3, with no two questions exploring the same underlying unknown. If seller-property identity is unknown, ask that before location, condition or other second-order detail. The absence of a valuation discussion, offer or booking is not itself unresolved context and is never the next action unless the prospect explicitly requested a valuation. recommended_actions contains only the smallest useful next steps, maximum 3 and usually 1–2. If the agency already established something, do not list it as unresolved or recommend asking it again. Never add generic CRM housekeeping such as flagging a hot lead, prioritising, escalating, or logging a dual-sided lead.
13. BILLERICAY RULE. The contact supplied a Billericay address. It is not the listed buyer property and is not stored as a seller-property address. Whether it is the property being sold is UNKNOWN unless communications establish that relationship. "Is the Billericay address the property you are planning to sell?" is legitimate. "Value the Billericay property" is not.
14. handling_summary is one short, factual whole-enquiry assessment. Use the real duration or response time supplied below, avoid duplicate detail, and do not turn a seller declaration into a separate enquiry stream. handling_quality is weak, mixed or strong. Keep the separate A-H grade unchanged; do not derive one from the other.
15. PROSPECT LANGUAGE. handling_summary and every string that may appear in the structured reading must make immediate sense to an estate agency owner. Never use internal NOVUS terms such as observation window, probe, finding, diagnosis, intelligence row, structured signal, source type, classification, pipeline, unresolved context, evidence window, recorded period, several signals or dual-sided lead. Use ordinary UK English instead.`;

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
    `Buyer qualification depth: ${intelligence.buyer_qualification || 'none'} (questions asked: ${intelligence.buyer_questions_asked || 'none'})`,
    `Seller/vendor recognition: ${intelligence.seller_recognition === '' ? 'n/a — no property declared for sale' : (intelligence.seller_recognition || 'none')}`,
    `Communication quality: ${intelligence.communication_quality || 'unknown'}`,
    `What they did well (from the communications): ${intelligence.did_well || '(nothing recorded)'}`,
    `What they missed (from the communications): ${intelligence.missed || '(nothing recorded)'}`,
    `Verbatim evidence quotes: ${intelligence.evidence || '(none)'}`,
  ].join('\n');
}

// Guards against a finding with no evidence, or evidence with no finding —
// the one piece of non-AI logic in this module. Also drops anything past the
// cap, in case the model over-returns despite the schema.
//
// forcedType: 'positive' for the positives array; undefined for the story
// findings, where the model's own 'problem'/'opportunity' choice is kept and
// anything else falls back to 'problem' (never to 'positive' — a mistyped
// finding must not become praise).
function sanitizeFindings(findings, { max, forcedType, probe, intelligence } = {}) {
  return (Array.isArray(findings) ? findings : [])
    .map((f) => {
      const declared = String(f?.finding_type || '').trim().toLowerCase();
      return {
        finding_type: forcedType || (STORY_FINDING_TYPES.includes(declared) ? declared : 'problem'),
        // Seller-side price attribution removed AT SOURCE, before the finding
        // is ever persisted to DIAGNOSIS_FINDINGS. Surgical, not sentence-
        // level: only the price reference in a seller clause goes, so an
        // evidenced finding is never emptied (and never dropped by the
        // finding/evidence filter below) by this guard.
        finding: stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(f?.finding || '').trim()), probe?.property_address),
        evidence: stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(f?.evidence || '').trim()), probe?.property_address),
        significance_note: stripEnquiryAddressAttribution(stripSellerPriceAttribution(String(f?.significance_note || '').trim()), probe?.property_address),
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
      // A declaration plus an absent valuation is not enough to create an
      // opportunity. Retain an opportunity only where the evidence itself
      // establishes something beyond declaration/recognition.
      if (f.finding_type === 'opportunity' && /seller|vendor|valuation|property to sell/i.test(`${f.finding} ${f.evidence}`)) {
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

function sanitizeHandlingSummary(value, intelligence, probe) {
  const period = enquiryPeriodPhrase(probe, { firstPerson: false });
  if (String(intelligence?.human_contact || '').toLowerCase() === 'none') {
    const attempts = Number.parseInt(intelligence?.contact_attempts, 10);
    if (!Number.isFinite(attempts) || attempts === 0) {
      return `No human contact was recorded ${period}; no response or follow-up attempt was made.`;
    }
  }
  const cleaned = cleanProspectText(value, probe).split(/(?<=[.!?])\s+/)[0] || '';
  if (wordCount(cleaned) <= 30) return cleaned;
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
  });

  // ONE ordered list, problems/opportunities first so finding_index 1 still
  // means "most commercially damaging" and every index already written to a
  // sheet keeps the meaning it had. Positives are appended after them.
  const storyFindings = sanitizeFindings(result.findings, { max: MAX_STORY_FINDINGS, probe, intelligence });
  const positiveFindings = sanitizeFindings(result.positive_findings, { max: MAX_POSITIVE_FINDINGS, forcedType: 'positive', probe, intelligence });
  // The per-probe cap, stated once rather than left implied by the two array
  // caps that already add up to it — a model that over-returns on both arrays
  // can never put a fifth row into DIAGNOSIS_FINDINGS.
  const findings = [...storyFindings, ...positiveFindings].slice(0, MAX_FINDINGS_PER_PROBE);
  let novusOpportunity = NOVUS_OPPORTUNITIES.includes(result.novus_opportunity) ? result.novus_opportunity : 'None evidenced';
  if (novusOpportunity === 'Growth (valuation list / seller conversion)'
      && !storyFindings.some((finding) => finding.finding_type === 'opportunity'
        && /seller|vendor|valuation|property to sell/i.test(`${finding.finding} ${finding.evidence}`))) {
    novusOpportunity = storyFindings.length ? 'Core (front desk)' : 'None evidenced';
  }
  const unresolvedContext = sanitizeUnresolvedContext(result.unresolved_context, intelligence, probe)
    .map((item) => (unresolvedTopic(item.question) === 'seller_property_identity'
      ? { ...item, why_it_matters: 'This must be clear before deciding whether the sale is relevant to the move.' }
      : item));

  // The same provenance rule on the prose DIAGNOSIS fields. sanitizeFindings()
  // has already applied it to every findings row above.
  return {
    findings: JSON.stringify(findings),
    enquiry_signals: JSON.stringify(sanitizeObjects(result.enquiry_signals, ['label', 'value', 'context', 'source_type'], 6, probe)
      .map((item) => ({ ...item, label: cleanProspectText(item.label, probe), value: cleanProspectText(item.value, probe), context: cleanProspectText(item.context, probe) }))),
    unresolved_context: JSON.stringify(unresolvedContext),
    recommended_actions: JSON.stringify(sanitizeRecommendedActions(result.recommended_actions, probe, unresolvedContext)),
    handling_summary: sanitizeHandlingSummary(result.handling_summary, intelligence, probe),
    handling_quality: HANDLING_QUALITIES.includes(result.handling_quality) ? result.handling_quality : 'mixed',
    strengths: cleanStructuredText(result.strengths, probe),
    missed_opportunities: cleanStructuredText(result.missed_opportunities, probe),
    commercial_implication: cleanStructuredText(result.commercial_implication, probe),
    novus_opportunity: novusOpportunity,
    diagnosis_summary: cleanStructuredText(result.diagnosis_summary, probe),
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
export const _internal = {
  TOOL, SYSTEM_PROMPT,
  MAX_FINDINGS_PER_PROBE, MAX_STORY_FINDINGS, MAX_POSITIVE_FINDINGS,
  sanitizeFindings, sanitizeObjects, questionAlreadyAnswered, unresolvedTopic,
  sanitizeUnresolvedContext, sanitizeRecommendedActions, sanitizeHandlingSummary,
};
