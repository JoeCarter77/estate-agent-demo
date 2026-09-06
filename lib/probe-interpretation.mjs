// lib/probe-interpretation.mjs — the ONE AI call that reads a probe's
// complete communication history and produces the eight AI-derived
// INTELLIGENCE fields (V2 schema, docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §3):
//   viewing_progression, buyer_qualification, buyer_questions_asked,
//   seller_recognition, communication_quality, did_well, missed, evidence.
//
// The probe contains buyer intent and may contain a seller declaration. The
// declaration is a SIGNAL, not proof of a viable valuation or instruction.
// This module records how the agency handled both the buyer enquiry and that
// additional context, plus the general behaviour dimensions:
//   BUYING  — the viewing (viewing_progression) and the buyer
//             (buyer_qualification / buyer_questions_asked)
//   SELLER CONTEXT — the declaration (seller_recognition), only when
//             PROBES.enquiry_text actually carries the vendor declaration —
//             lib/vendor-intent.mjs's hasVendorDeclaration() gate, kept
//             exactly as before
//   GENERAL — communication_quality, did_well, missed
//
// Every claim the model makes must be backed by a verbatim quote tied to a
// communication_id. validateEvidence() below checks each quote is a literal
// substring (after whitespace normalisation) of the actual message it cites
// — the guard against the model inventing wording that was never sent. A
// quote that fails is dropped, never trusted.
//
// buyer_qualification is NOT trusted directly from the model: it is floored
// deterministically from how many buyer_questions_asked survive validation,
// so "thorough" is a count-backed finding, not an opinion (schema §3, field 12).
//
// Pure orchestration + one AI call. No sheet I/O — callers (observation-
// recompute.mjs, intelligence-rebuild.mjs) pass in the probe + communications
// they already loaded and write the result themselves.

import { callAi } from './ai-client.mjs';
import { isHumanCommunication } from './classification.mjs';
import { hasVendorDeclaration } from './vendor-intent.mjs';

const VIEWING_LEVELS = ['none', 'mentioned', 'invited', 'availability_requested', 'slot_offered', 'booked'];
const SELLER_LEVELS = ['none', 'asked_position', 'acknowledged', 'valuation_offered', 'valuation_booked'];
const QUALITY_LEVELS = ['poor', 'generic', 'competent', 'strong'];

const QUALIFICATION_DEPTH_BY_COUNT = (n) => {
  if (n >= 6) return 'thorough';
  if (n >= 3) return 'standard';
  if (n >= 1) return 'minimal';
  return 'none';
};

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function contentOf(comm) {
  return [comm.subject, comm.body_text, comm.transcript, comm.raw_content]
    .filter(Boolean)
    .join('\n');
}

// True when `quote` is a literal (whitespace-normalised) substring of the
// content of the communication it claims to cite.
function quoteIsGenuine(quote, comm) {
  if (!quote || !comm) return false;
  const haystack = normalize(contentOf(comm));
  const needle = normalize(quote);
  return needle.length > 0 && haystack.includes(needle);
}

const TOOL = {
  name: 'record_probe_interpretation',
  description: 'Record the behavioural interpretation of an agency\'s communications for one probe.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['viewing_progression', 'buyer_questions_asked', 'communication_quality', 'did_well', 'missed', 'evidence'],
    properties: {
      viewing_progression: { type: 'string', enum: VIEWING_LEVELS },
      buyer_questions_asked: {
        type: 'array',
        description: 'Genuine buyer-qualification questions the agency asked, one entry per topic actually asked.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['topic', 'quote', 'communication_id'],
          properties: {
            topic: { type: 'string', description: 'Short label, e.g. "current property position", "finance", "budget".' },
            quote: { type: 'string', description: 'Verbatim text from the message that asked this question.' },
            communication_id: { type: 'string' },
          },
        },
      },
      seller_recognition: {
        type: 'string',
        enum: SELLER_LEVELS,
        description: 'Only meaningful when the enquiry declared a property to sell. Omit/none otherwise.',
      },
      communication_quality: { type: 'string', enum: QUALITY_LEVELS },
      did_well: { type: 'string', description: 'What the agency got right. Empty string if genuinely nothing stands out.' },
      missed: { type: 'string', description: 'What was on the table and not taken. Empty string if nothing was missed.' },
      evidence: {
        type: 'array',
        description: 'Every verbatim quote used anywhere above, so each claim is checkable.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['quote', 'communication_id'],
          properties: {
            quote: { type: 'string' },
            communication_id: { type: 'string' },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are reading an estate agency's real communications in response to a test enquiry ("probe"), to extract exactly what happened — never to guess, flatter, or manufacture a commercial problem.

The enquiry concerns a listed property and may also contain a declaration that the enquirer has a property to sell. That declaration is a SIGNAL only. It does not prove a viable valuation, instruction, seller-property address, location, value, or dependency between the purchase and sale.

Evaluate what the agency's own communications show, and nothing else:
- viewing_progression: how far they moved the viewing along, from "none" up to "booked".
- buyer_questions_asked: list ONLY genuine qualification questions actually asked in the messages — partner details, current address, current property position, finance/mortgage, budget, requirements, target areas, timescale, motivation, viewing availability, and similar. Do not invent one to pad the list.
- seller_recognition: only relevant if the enquiry text below declares a property to sell. Record only what the agency actually did with that context — "none" if never mentioned, up to "valuation_booked" when the communications explicitly support it. No valuation was necessarily appropriate.
- communication_quality: judge the craft of the response, independent of speed — does it name the property and the person, read as written for this enquiry rather than a template blast, give a way back, and move toward something.
- did_well / missed: concrete, evidence-backed observations. An important declaration that remained unclarified may be described as unresolved context, never automatically as a missed valuation or seller opportunity. Leave either as an empty string if there is genuinely nothing to say.

Never infer that the listed property address or price belongs to the property the enquirer may sell. Never infer that a seller declaration made a valuation appropriate, or that no valuation offer was a commercial miss.

Every quote you give MUST be copied verbatim from the message text you were shown, including its communication_id. Do not paraphrase into quotation marks. A quote that does not appear in the source will be discarded and the claim it supports will be dropped, so accuracy here is what makes the rest of your answer count.`;

function buildPrompt(probe, communications) {
  const vendorDeclared = hasVendorDeclaration(probe);
  const ordered = communications
    .map((c) => ({ ...c, _at: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._at.getTime()))
    .sort((a, b) => a._at - b._at);

  const lines = ordered.map((c, i) => {
    const who = isHumanCommunication(c) ? 'human' : 'automated';
    const content = contentOf(c) || '(no content)';
    return `--- Message ${i + 1} | communication_id: ${c.communication_id} | channel: ${c.channel || 'unknown'} | occurred_at: ${c.occurred_at} | sender: ${who} ---\n${content}`;
  });

  return [
    `Property: ${probe.property_address || 'unknown'} (${probe.property_price || 'price unknown'})`,
    `Enquiry text: ${probe.enquiry_text || '(none)'}`,
    `Vendor/seller opportunity declared: ${vendorDeclared ? 'YES — evaluate seller_recognition' : 'NO — leave seller_recognition as "none"'}`,
    '',
    ordered.length > 0 ? lines.join('\n\n') : '(No communications have been received for this probe yet.)',
  ].join('\n');
}

// probe: PROBES row. communications: this probe's COMMUNICATIONS rows.
// -> { viewing_progression, buyer_qualification, buyer_questions_asked,
//      seller_recognition, communication_quality, did_well, missed, evidence }
export async function interpretProbe(probe, communications) {
  const vendorDeclared = hasVendorDeclaration(probe);
  const byId = new Map(communications.map((c) => [c.communication_id, c]));

  if (communications.length === 0) {
    return {
      viewing_progression: 'none',
      buyer_qualification: 'none',
      buyer_questions_asked: '',
      seller_recognition: vendorDeclared ? 'none' : '',
      communication_quality: 'poor',
      did_well: '',
      missed: vendorDeclared
        ? 'No communication of any kind was received; the buyer enquiry was not handled and the declared seller context remained unresolved.'
        : 'No communication of any kind was received; the viewing enquiry was never addressed.',
      evidence: '',
    };
  }

  const result = await callAi({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(probe, communications),
    tool: TOOL,
    purpose: 'interpretation',
  });

  // Validate every buyer question's quote against its cited message.
  const genuineQuestions = (result.buyer_questions_asked || [])
    .filter((q) => q && q.topic && quoteIsGenuine(q.quote, byId.get(q.communication_id)));

  // Validate the shared evidence list the same way.
  const genuineEvidence = (result.evidence || [])
    .filter((e) => e && quoteIsGenuine(e.quote, byId.get(e.communication_id)))
    .map((e) => {
      const comm = byId.get(e.communication_id);
      return `"${e.quote.trim()}" (${comm.channel || 'unknown channel'}, ${comm.occurred_at})`;
    });

  const viewingProgression = VIEWING_LEVELS.includes(result.viewing_progression) ? result.viewing_progression : 'none';
  const sellerRecognition = vendorDeclared
    ? (SELLER_LEVELS.includes(result.seller_recognition) ? result.seller_recognition : 'none')
    : '';
  const communicationQuality = QUALITY_LEVELS.includes(result.communication_quality) ? result.communication_quality : 'generic';

  return {
    viewing_progression: viewingProgression,
    buyer_qualification: QUALIFICATION_DEPTH_BY_COUNT(genuineQuestions.length),
    buyer_questions_asked: genuineQuestions.map((q) => q.topic).join('; '),
    seller_recognition: sellerRecognition,
    communication_quality: communicationQuality,
    did_well: String(result.did_well || '').trim(),
    missed: String(result.missed || '').trim(),
    evidence: genuineEvidence.join('; '),
  };
}

export const _internal = { quoteIsGenuine, normalize, contentOf, QUALIFICATION_DEPTH_BY_COUNT, VIEWING_LEVELS, SELLER_LEVELS, QUALITY_LEVELS };
