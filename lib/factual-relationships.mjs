// lib/factual-relationships.mjs — the relationship & provenance validation
// layer (contract rules 41-48).
//
// THE FAILURE THIS EXISTS TO CLOSE. Every other factual guard in this pipeline
// asks "is this FACT true?" — is that figure ours to state, did that reply
// happen, is that address the seller's. They all pass a sentence built from
// facts that are each individually true. This layer asks the different
// question: "is this RELATIONSHIP between the facts true?"
//
//   Fact: the enquiry declared a property to sell.   TRUE
//   Fact: the agency called twice.                   TRUE
//   Claim: "I was already on the phone with you twice, and still told you
//          I had a property to sell."                FALSE
//
// Nothing in that sentence is an invented fact. The invention is the JOIN —
// a declaration that lived in the original enquiry has been relocated into two
// phone calls it was never part of. Same shape for a co-occurrence that never
// co-occurred, a certainty drawn from a record whose content is unknown, a
// comparison nobody made, and knowledge attributed to people who were never
// asked.
//
// SUPPORT-RELATIVE, NOT A BLACKLIST. This is the design constraint, and it is
// not decoration: the very same words are true or false depending on the
// probe. "The vendor had already volunteered themselves in the same message"
// is CORRECT copy — the probe's own enquiry really did carry the viewing
// request and the seller declaration together, and hasVendorDeclaration()
// says so deterministically. The identical phrase is FALSE when it binds that
// enquiry fact to a later agency email. So every detector below takes a
// SUPPORT CONTEXT — the probe facts, the selected findings, and the minimum
// structured intelligence state — and rejects a claim only when the support
// set does not license it.
//
// WHAT COUNTS AS SUPPORT, in order of authority:
//   1. PROBES facts — enquiry_text, and the deterministic
//      hasVendorDeclaration() marker written at probe creation;
//   2. the SELECTED DIAGNOSIS_FINDINGS — their finding, evidence and
//      significance_note text;
//   3. two booleans the caller has already computed from those findings
//      (whether a prospect-side contact is evidenced, and whether a call
//      record's content is unknown), passed in rather than recomputed here so
//      this module needs no import back into lib/probe-personalisation.mjs.
//
// Nothing else licenses anything. In particular the DIAGNOSIS prose is not a
// support source — it is non-authoritative downstream, and this layer never
// sees it.

import { hasVendorDeclaration } from './vendor-intent.mjs';

// A negated form is a TRUE statement about the probe and must survive: "I
// never told you on the call", "nobody else knew" is different from "before
// anyone else knew". Matched over the offending span only, same convention as
// the prospect-reply guard in lib/probe-personalisation.mjs.
const NEGATOR_RE = /\b(?:never|not|no|n['’]t|without|nor)\b/i;

const unnegated = (text, re) => {
  const match = String(text || '').match(re);
  return match ? !NEGATOR_RE.test(match[0]) : false;
};

// ── The support context ─────────────────────────────────────────────────────
//
// prospectContactEvidenced / callContentUnknown are computed by the caller
// (lib/probe-personalisation.mjs already derives both from the SELECTED
// findings for its existing guards) and passed in, so the same judgement is
// never made twice from two slightly different code paths.
export function buildSupportContext({
  probe, findings, intelligence, prospectContactEvidenced = false, callContentUnknown = false,
} = {}) {
  const selected = Array.isArray(findings) ? findings : [];
  const selectedText = selected.map((f) => `${f?.finding || ''} ${f?.evidence || ''} ${f?.significance_note || ''}`);
  const findingsText = selectedText.join('\n');
  const attempts = Number.parseInt(intelligence?.contact_attempts, 10);
  const followUps = Number.parseInt(intelligence?.follow_ups, 10);
  return {
    findingsText,
    enquiryText: String(probe?.enquiry_text || ''),
    // THE AUTHORITATIVE COUNTS. lib/intelligence-fields.mjs derives these
    // deterministically and buildOpportunityShape() already prints them into
    // the prompt as "the only counts you may cite". They are the single source
    // for how many times the agency came back, so copy citing a different
    // number is simply wrong — and it is the one claim an agent can check in
    // three seconds against their own sent items.
    contactAttempts: Number.isFinite(attempts) ? attempts : null,
    followUps: Number.isFinite(followUps) ? followUps : null,
    // The deterministic probe marker: the seller position was declared in the
    // ORIGINAL ENQUIRY. This is what licenses "it was all in the same message"
    // and what makes "I told you on the call" a relocation.
    sellerDeclaredInEnquiry: hasVendorDeclaration(probe),
    // The exact cross-event shape behind an otherwise elliptical "same
    // message" claim: the seller fact is explicitly located in the original
    // enquiry, while the selected buyer-side progression is explicitly
    // located in a later agency communication.
    selectedFactsSpanEvents: selectedText.some((text) =>
      /\b(?:original|initial|opening|first)\s+(?:enquiry|message|email)\b/i.test(text)
      && SELLER_SIDE_CONTEXT.test(text))
      && selectedText.some((text) =>
        /\b(?:agency|agent|branch|team)\b/i.test(text)
        && /\b(?:email|reply|response|message)\b/i.test(text)
        && /\b(?:view(?:ing)?|availability|convenient)\b/i.test(text)),
    prospectContactEvidenced,
    callContentUnknown,
  };
}

// Does the support set itself already state this? Used by the comparative and
// third-party detectors, where the only legitimate licence is that a selected
// finding genuinely made the claim first.
function supportStates(support, re) {
  return re.test(support?.findingsText || '') || re.test(support?.enquiryText || '');
}

// The seller side of the enquiry, named however it is named. Shared by the
// co-occurrence and certainty rules, both of which are about seller-side
// provenance specifically rather than about any claim in the sentence.
const SELLER_SIDE_CONTEXT = /\bsell(?:er|ing)?\b|\bvendor\b|\bvaluation\b|\bmarket\b|\binstruct\w*\b/i;

// ── Rule 41/47: co-occurrence ───────────────────────────────────────────────
//
// "Both opportunities were in the same message" is one of the strongest true
// things this product says — when both really were in the enquiry. It becomes
// false the moment the "same message" is an AGENCY message, because then it is
// welding a fact from my enquiry onto an event that happened days later.
//
// So the test is the ANCHOR, not the phrase. An agency-owned anchor ("your
// reply", "the email you sent", "that call") carrying a prospect-side
// declaration is a relocation. An enquiry-owned or unmarked anchor is the
// ordinary, correct usage, and is licensed by the deterministic
// hasVendorDeclaration() marker.
const CO_OCCURRENCE_MARKER = /\b(?:in|inside|within)\s+(?:that\s+|the\s+|this\s+|one\s+)?(?:very\s+)?same\s+(?:message|email|enquiry|note|reply|response|call|conversation)\b|\bthe\s+(?:very\s+)?same\s+(?:message|email|enquiry|note|reply|response|call|conversation)\b|\bone\s+and\s+the\s+same\s+(?:message|email|reply|response)\b|\bboth\s+(?:sat|sit|were|arrived|came)\s+in\s+(?:the\s+)?(?:very\s+)?same\b/i;

// "The second opportunity" is the seller-side fact expressed elliptically:
// the selected findings supply what the two opportunities are. Keep this
// narrow so unrelated uses of "opportunity" remain outside this rule.
const IMPLICIT_SELLER_OPPORTUNITY = /\b(?:second|other|additional)\s+opportunit(?:y|ies)\b/i;

// The anchor is the agency's: their reply, their call, something THEY sent.
// "the same message had already given you a second reason to call" is mine —
// it is the message that gave THEM something, so it reads as inbound.
const AGENCY_OWNED_ANCHOR = /\b(?:your|that)\s+(?:reply|response|email|message|call|voicemail|follow[- ]?up)\b[^.!?]{0,40}\bsame\b|\bsame\b[^.!?]{0,40}\b(?:you\s+sent|you\s+replied|your\s+reply|your\s+response|you\s+came\s+back|your\s+email|your\s+voicemail|the\s+callback)\b|\bsame\s+(?:call|voicemail|reply|response)\b/i;

// A DEMONSTRATIVE ANCHOR MAKES THE SAME CLAIM WITHOUT THE WORD "same".
// "That call also covered the property I had to sell" gives an agency event
// the contents of my enquiry, which is the co-occurrence failure reached
// through a different door. The tell is the INCLUSION verb: covered,
// contained, included, dealt with, "also" — a demonstrative on its own ("that
// call came within the hour") claims no co-occurrence and is untouched.
const AGENCY_EVENT_ANCHOR = /\b(?:that|the|your)\s+(?:call|email|reply|response|message|voicemail|follow[- ]?up|callback)\b/i;
const INCLUSION_VERB = /\b(?:also\s+(?:covered|contained|included|dealt\s+with|mentioned|raised|addressed|handled)|covered\s+both|contained\s+both|included\s+both|dealt\s+with\s+both|handled\s+both|covered|contained|included|dealt\s+with)\b/i;

export function addsUnsupportedCoOccurrence(text, support) {
  const t = String(text || '').trim();
  const demonstrativeCoOccurrence = AGENCY_EVENT_ANCHOR.test(t) && INCLUSION_VERB.test(t);
  if (!t || (!CO_OCCURRENCE_MARKER.test(t) && !demonstrativeCoOccurrence)) return false;
  // SCOPED TO THE FACT WHOSE PROVENANCE IS AT STAKE. This rule protects one
  // thing: that the seller declaration stays in the message it was actually
  // made in. A co-occurrence claim carrying no seller-side content is about
  // something else entirely ("you answered the price question but ignored the
  // availability question in the same message"), and this rule has nothing to
  // say about it.
  if (!SELLER_SIDE_CONTEXT.test(t) && !IMPLICIT_SELLER_OPPORTUNITY.test(t)) return false;
  // An evidenced prospect-side exchange licenses any of this outright.
  if (support?.prospectContactEvidenced) return false;
  // An agency event told it "also contained" my declaration has taken a fact
  // out of my enquiry. There is no version of that the enquiry marker can
  // license, so it is rejected outright.
  if (demonstrativeCoOccurrence) return true;
  if (AGENCY_OWNED_ANCHOR.test(t)) return true;
  if (support?.selectedFactsSpanEvents) return true;
  // Unmarked or enquiry-owned: correct usage, provided the enquiry really did
  // carry the declaration the claim rests on.
  return !support?.sellerDeclaredInEnquiry;
}

// ── Rule 43/47: prospect response events ───────────────────────────────────
//
// A response can be asserted as a NOUN as well as a subject+verb clause:
// "off the back of that answer" still says an answer happened. Likewise,
// "once I confirmed" asserts a prospect action even though confirmation is
// not one of the contact verbs used by the conversational reply guard.
// Original-enquiry declaration verbs remain deliberately outside this rule.
const PERSONALISATION_RESPONSE_NOUN = String.raw`(?:answer|reply|response|confirmation|callback)`;
const PERSONALISATION_RESPONSE_VERB = String.raw`(?:answer(?:ed|ing)?|repl(?:y|ied|ying)|respond(?:ed|ing)?|confirm(?:ed|ing)?|call(?:ed|ing)?\s+(?:you\s+)?back)`;
const PROSPECT_RESPONSE_EVENT = [
  new RegExp(String.raw`\b(?:my|our)\s+${PERSONALISATION_RESPONSE_NOUN}\b`, 'i'),
  new RegExp(String.raw`\b(?:off\s+the\s+back\s+of|following|after|based\s+on|because\s+of)\s+(?:(?:my|our|that|the)\s+)?${PERSONALISATION_RESPONSE_NOUN}\b`, 'i'),
  new RegExp(String.raw`\b(?:once|after|when|following)\b[^.!?]{0,20}\b(?:I|we)\b[^.!?]{0,12}\b${PERSONALISATION_RESPONSE_VERB}\b`, 'i'),
];

export function addsUnsupportedProspectResponse(text, support) {
  const t = String(text || '').trim();
  if (!t || support?.prospectContactEvidenced) return false;
  return PROSPECT_RESPONSE_EVENT.some((re) => unnegated(t, re));
}

// ── Rule 42/47: declaration timing ──────────────────────────────────────────
//
// The seller position was stated ONCE, in the original enquiry, and the probe
// never speaks again. So a first-person declaration verb pinned to an agency
// contact event — on that call, during the call, while we were on the phone,
// when you rang — has moved a fact out of the only moment it ever occupied.
//
// This is deliberately about the LOCATOR, not the verb: "I'd also said I had a
// property to sell" carries no locator and is the correct phrasing, used
// verbatim across the existing suites. Only the pinning is rejected.
const AGENCY_CONTACT_LOCATOR = String.raw`on\s+(?:that|the|either|both|those)\s+calls?|in\s+(?:that|the)\s+calls?|during\s+(?:that|the|either|both)\s+calls?|on\s+the\s+phone(?:\s+with\s+you)?|while\s+we\s+were\s+on\s+the\s+phone|when\s+you\s+(?:called|rang|phoned)|in\s+your\s+(?:reply|email|message|voicemail)|on\s+(?:that|the)\s+voicemail`;
const FIRST_PERSON_DECLARATION = String.raw`(?:I|we)\s+(?:\w+\s+){0,3}?(?:said|told\s+you|mentioned|confirmed|declared|stated|explained|let\s+you\s+know|made\s+it\s+clear|spelled\s+it\s+out)`;

const DECLARATION_TIMING_PATTERNS = [
  new RegExp(String.raw`\b(?:${AGENCY_CONTACT_LOCATOR})\b[^.!?]{0,60}\b${FIRST_PERSON_DECLARATION}\b`, 'i'),
  new RegExp(String.raw`\b${FIRST_PERSON_DECLARATION}\b[^.!?]{0,60}\b(?:${AGENCY_CONTACT_LOCATOR})\b`, 'i'),
  // "I was already on the phone with you twice, and still told you ..." — the
  // locator and the declaration sit in coordinated clauses rather than one.
  new RegExp(String.raw`\b(?:I|we)\s+(?:was|were)\s+(?:already\s+)?on\s+the\s+phone\b[^.!?]{0,80}\b(?:still\s+|then\s+|and\s+)?(?:told\s+you|said|mentioned|confirmed)\b`, 'i'),
];

export function addsUnsupportedDeclarationTiming(text, support) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (support?.prospectContactEvidenced) return false;
  return DECLARATION_TIMING_PATTERNS.some((re) => unnegated(t, re));
}

// ── Rule 43: causal joins onto a prospect action ────────────────────────────
//
// Scoped narrowly and on purpose. Ordinary commercial implication — "that
// meant the valuation was never booked" — is the email's JOB, is agency-side,
// and is already governed by consequenceGoesBeyondFinding() and the
// speculative-behaviour guard. Blocking "meant" wholesale would delete correct
// copy across every existing fixture.
//
// What is rejected is the causal join that manufactures a two-way exchange:
// the agency did X, SO I did Y. That invents a prospect action and a causal
// link in one move, and it is the only causal shape the real failures produced.
const CAUSAL_TO_PROSPECT_ACTION = new RegExp(
  String.raw`\b(?:so|because|which\s+meant|which\s+is\s+why|therefore|as\s+a\s+result|prompting)\b[^.!?]{0,40}\b(?:I|we)\s+(?:\w+\s+){0,2}?(?:replied|responded|confirmed|answered|came\s+back|told\s+you|got\s+in\s+touch|called)\b`,
  'i',
);

export function addsUnsupportedCausalLink(text, support) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (support?.prospectContactEvidenced) return false;
  return unnegated(t, CAUSAL_TO_PROSPECT_ACTION);
}

// ── Rule 45/48: certainty ───────────────────────────────────────────────────
//
// Two separate upgrades, one rule: keep the evidence's epistemic level.
//
// (a) A POTENTIAL seller opportunity is not an INSTRUCTION. "Instruction" and
//     "listing" name a thing the agency has actually won; the probe only ever
//     evidences that one might have been available. Gated to the seller side,
//     because "callback instruction" is an unrelated and legitimate use that
//     appears in existing pinned copy.
const DEFINITE_SELLER_NOUN = /\b(?:the|a|an|that|this|your|my)\s+(?:\w+\s+){0,2}?(?:instruction|listing)\b/i;
const POSSIBILITY_HEDGE = /\bpotential\b|\bpossible\b|\bpossibly\b|\bwould(?:\s+have)?\b|\bcould(?:\s+have)?\b|\bmight\b|\bmay\b|\blikely\b|\bchance\b|\bopportunit(?:y|ies)\b|\bprospect(?:ive)?\b/i;
// Anything the callback/next-step sense of "instruction" belongs to. These are
// not seller instructions at all and must never be read as one.
const NON_SELLER_INSTRUCTION = /\b(?:callback|call[- ]back|contact|delivery|joining|dialling|payment)\s+instructions?\b/i;

export function upgradesPossibilityToCertainty(text, support) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!DEFINITE_SELLER_NOUN.test(t)) return false;
  if (NON_SELLER_INSTRUCTION.test(t)) return false;
  if (!SELLER_SIDE_CONTEXT.test(t)) return false;
  // A hedge in the same sentence keeps the epistemic level honest.
  if (POSSIBILITY_HEDGE.test(t)) return false;
  // Licensed when a selected finding genuinely records a won instruction
  // rather than a potential one.
  return !supportStates(support, /\b(?:instruction|listing)\b/i)
    || POSSIBILITY_HEDGE.test(support?.findingsText || '');
}

// (b) Unknown content is not empty content, and it is not known content
//     either. When a selected finding says the call record was never captured
//     (or is damaged), nothing may assert what was or was not said ON that
//     call. lib/probe-personalisation.mjs owns the detection of that
//     uncertainty and the evidence-bounded escape hatch; this is the piece it
//     was missing — the DEFINITE claim about the call's content that is
//     phrased as a person rather than as content ("nobody on that call asked
//     about X"), which its "the call had no content" patterns never matched.
// The same evidence-bounded escape hatch lib/probe-personalisation.mjs uses,
// restated here rather than imported: this module deliberately depends on
// nothing but vendor-intent.mjs, and importing back into probe-personalisation
// would create a cycle. Both say the same thing — a statement about OUR RECORD
// asserts nothing about what was actually said, and is always allowed.
const EVIDENCE_BOUNDED = /\bthere\s+(?:is|was)\s+no\s+(?:recorded|evidenced|available|logged)\b|\bno\s+(?:recorded|evidenced|logged)\b[^.!?]{0,32}\bshow(?:s|ing|n)?\b|\bfrom\s+the\s+available\s+(?:call\s+)?record\b|\bno\s+evidenced\b|\b(?:call\s+)?record\s+does\s+not\s+show\b/i;

const CALL_LOCATOR = /\bon\s+(?:that|the|either|both|those)\s+calls?\b|\bin\s+(?:that|the)\s+calls?\b|\bduring\s+(?:that|the|either|both)\s+calls?\b|\bon\s+(?:that|the)\s+voicemail\b|\bon\s+the\s+phone\b/i;
const DEFINITE_CONTENT_CLAIM = /\b(?:nobody|no[- ]one|nothing|neither|never|not\s+once|didn['’]t|did\s+not|wasn['’]t|weren['’]t)\b/i;
const CONTENT_VERB = /\b(?:ask(?:ed)?|mention(?:ed)?|raise(?:d)?|discuss(?:ed)?|say|said|offer(?:ed)?|cover(?:ed)?|bring\s+up|brought\s+up|talk(?:ed)?\s+about|explore(?:d)?|address(?:ed)?)\b/i;

// THE SAME CLAIM WITH NO LOCATOR AT ALL. "The seller opportunity was never
// discussed" names no call, but there is only one record of what was said and
// it was never captured — so the sentence still reports the contents of
// something nobody has. The locator requirement above is what keeps
// whole-record wording sayable, and that stays: the distinction is the VERB.
//
//   DISCUSSION verbs — discussed, mentioned, raised, brought up, came up,
//     talked about — report what was SAID. Unknown content cannot support a
//     universal negative about any of them.
//   OUTCOME verbs — picked up, acknowledged, progressed, offered, actioned —
//     report what the agency DID with the enquiry, judged across the whole
//     record. Those stay fully sayable and are pinned copy across the suites.
const DISCUSSION_VERB = /\b(?:discussed|mentioned|raised|brought\s+up|came\s+up|talked\s+about|spoken\s+about|referred\s+to)\b/i;
const UNIVERSAL_NEGATIVE = /\b(?:never|not\s+once|at\s+no\s+point|nobody|no[- ]one|wasn['’]?t|weren['’]?t|didn['’]?t|was\s+not|were\s+not)\b/i;

export function claimsKnownContentOfUnknownCall(text, support) {
  const t = String(text || '').trim();
  if (!t || !support?.callContentUnknown) return false;
  // Evidence-bounded wording describes OUR RECORD and is the correct way to
  // make this point, whatever else the sentence says.
  if (EVIDENCE_BOUNDED.test(t)) return false;
  if (CALL_LOCATOR.test(t)) return DEFINITE_CONTENT_CLAIM.test(t) && CONTENT_VERB.test(t);
  // No locator: only a universal negative about what was SAID is blocked.
  return UNIVERSAL_NEGATIVE.test(t) && DISCUSSION_VERB.test(t);
}

// ── Rule 44: comparatives ───────────────────────────────────────────────────
//
// Nothing in this pipeline measures the seller opportunity against the buyer
// one. There is no figure for the seller property (that is the seller-price
// rule), no probability attached to either, and no finding that ranks them. So
// "the more valuable seller opportunity" is a judgement invented at the point
// of writing — and it is the kind an agent will argue with, which is worse
// than saying nothing.
//
// Licensed only where a selected finding made the comparison itself.
const VALUE_COMPARATIVE = /\b(?:more|less|greater|higher|bigger|larger|smaller|stronger|weaker|better|worse)\s+(?:\w+\s+){0,2}?(?:valuable|value|important|significant|lucrative|profitable|worthwhile|opportunit(?:y|ies)|lead|leads|prospect|prospects|earner)\b|\bworth\s+(?:far\s+|much\s+|significantly\s+)?more\b|\bthe\s+(?:bigger|larger|greater|more\s+valuable)\s+(?:of\s+the\s+two|opportunity|prize|half|side)\b|\barguably\s+(?:the\s+)?(?:more|most)\b/i;

export function addsUnsupportedComparative(text, support) {
  const t = String(text || '').trim();
  if (!t || !VALUE_COMPARATIVE.test(t)) return false;
  return !supportStates(support, VALUE_COMPARATIVE);
}

// ── Rule 46: third-party and internal knowledge ─────────────────────────────
//
// We know what the agency SENT. We know nothing about what anyone else knew,
// what the market had seen, or what the agency privately believed — those are
// mind-states of people who were never asked, and a probe cannot evidence one.
//
// Deliberately scoped to an EXCLUSIVE-OTHER subject ("anyone else", "another
// agent", "competitors", "the market") holding a KNOWLEDGE state about this
// property. A general statement of market practice — "most branches work the
// buying side and never notice the second half" — is a different claim: it
// describes what agencies typically DO, asserts nothing about who knew about
// THIS enquiry, and is pinned as correct copy in the existing suite.
// Singular and plural alike: "no other agent knew" asserts a mind-state just
// as confidently as "other agents knew", and neither is evidenced. The rule is
// that we cannot see inside anyone else's head, in either direction, so the
// negated form is caught too rather than being read as a safe denial.
const OTHER_PARTY_SUBJECT = String.raw`(?:any|no|some|every)\s?(?:one|body)\s+else|an?(?:nother)?\s+other\s+(?:agent|agency|branch)|another\s+(?:agent|agency|branch)|(?:no|any|some|the|other)\s+other\s+(?:agents?|agenc(?:y|ies)|branch(?:es)?)|other\s+(?:agents?|agenc(?:y|ies)|branch(?:es)?)|competitors?|rivals?|the\s+market|the\s+competition`;
const KNOWLEDGE_STATE = String.raw`knew|knows|know|aware|realis\w+|realiz\w+|heard\s+about|had\s+seen|had\s+heard|found\s+out|got\s+wind`;
const INTERNAL_BELIEF = /\b(?:you|they|the\s+(?:agency|branch|team))\s+(?:probably|presumably|must\s+have|might\s+have|may\s+have|no\s+doubt|clearly)\s+(?:thought|assumed|believed|decided|felt|reckoned|figured)\b/i;

const THIRD_PARTY_KNOWLEDGE = new RegExp(
  String.raw`\b(?:${OTHER_PARTY_SUBJECT})\b[^.!?]{0,32}\b(?:${KNOWLEDGE_STATE})\b|\b(?:${KNOWLEDGE_STATE})\b[^.!?]{0,24}\b(?:before|ahead\s+of)\s+(?:${OTHER_PARTY_SUBJECT})\b|\bbefore\s+(?:${OTHER_PARTY_SUBJECT})\b[^.!?]{0,32}\b(?:${KNOWLEDGE_STATE})\b`,
  'i',
);

export function addsUnsupportedThirdPartyKnowledge(text, support) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (INTERNAL_BELIEF.test(t) && !supportStates(support, INTERNAL_BELIEF)) return true;
  if (!THIRD_PARTY_KNOWLEDGE.test(t)) return false;
  return !supportStates(support, THIRD_PARTY_KNOWLEDGE);
}



// ── Class 1: universal quantifiers ──────────────────────────────────────────
//
// "Each time you called, nobody mentioned it" is a claim about EVERY call.
// "All three attempts ignored the seller side" is a claim about each of the
// three. The evidence behind them is almost always a single observation about
// the record as a whole, so the quantifier is doing work nothing supports —
// and it is the part an agent will pick apart, because they only need one
// counter-example out of N.
//
// The honest version of the same point drops the enumeration: "the property I
// said I had to sell was never acknowledged" asserts one thing about the
// record and is fully supported. So this rejects the QUANTIFIER, never the
// point it was attached to.
//
// SUPPORTED when the findings made the universal themselves — a finding
// reading "none of the three messages mentioned the seller position" has
// established it across the set, and copy may then say so.
const UNIVERSAL_QUANTIFIER = /\b(?:each\s+time|every\s+time|all\s+(?:\w+\s+)?(?:attempts?|calls?|messages?|emails?|contacts?|times|follow[- ]?ups?)|none\s+of\s+(?:them|those|these|the\s+\w+)|not\s+one\s+of\s+(?:them|those|these|the\s+\w+)|every\s+(?:one\s+of\s+)?(?:your\s+)?(?:attempts?|calls?|messages?|emails?|contacts?)|neither\s+call|both\s+calls)\b/i;

// The universal has to be ABOUT the contact set to matter here. "All the
// value sat in the second half of the message" enumerates nothing.
const CONTACT_SET_SUBJECT = /\b(?:attempts?|calls?|called|messages?|emails?|contacts?|follow[- ]?ups?|times|them|those|these)\b/i;

export function addsUnsupportedUniversal(text, support) {
  const t = String(text || '').trim();
  if (!t || !UNIVERSAL_QUANTIFIER.test(t)) return false;
  if (!CONTACT_SET_SUBJECT.test(t)) return false;
  // Licensed where a selected finding already established it across the set.
  return !supportStates(support, UNIVERSAL_QUANTIFIER);
}

// ── Class 4: contact counts ─────────────────────────────────────────────────
//
// One authoritative count, and everything else is rejected. The number is
// INTELLIGENCE.contact_attempts (follow_ups for the follow-up phrasing) —
// already deterministic, already the only count the prompt offers.
//
// Only the count is checked. Copy that cites no number is untouched, and so is
// copy on a probe whose count was never recorded.
const NUMBER_WORDS = new Map([
  ['once', 1], ['one', 1], ['twice', 2], ['two', 2], ['three', 3], ['four', 4],
  ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
]);

const countOf = (word) => (NUMBER_WORDS.has(word.toLowerCase())
  ? NUMBER_WORDS.get(word.toLowerCase())
  : Number.parseInt(word, 10));

// "called three times", "came back to me 5 times", "chased twice".
//
// A COUNT UNIT IS REQUIRED, and this is the whole reason the rule is safe to
// run over every sentence: a bare number next to a contact verb is usually not
// a count at all. "Your team called back in 36 MINUTES" is a duration, "you
// replied within 2 HOURS" is a duration, "you called about the £425,000
// property" is a price. Reading any of them as a contact count would reject
// correct copy on almost every probe. So the number must either carry an
// explicit "time(s)", or be one of the two words that can only ever mean a
// count — once and twice.
const COUNT_TOKEN = String.raw`(?:(once|twice)|(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+times?)`;
const CONTACT_COUNT_RE = new RegExp(
  String.raw`\b(?:call(?:ed)?|rang|phoned|chased|contacted|came\s+back(?:\s+to\s+me)?|got\s+back(?:\s+to\s+me)?|reached\s+out|tried)\b[^.!?]{0,24}?\b${COUNT_TOKEN}\b`,
  'gi',
);
const FOLLOW_UP_COUNT_RE = new RegExp(
  String.raw`\bfollow(?:ed)?[- ]?up\b[^.!?]{0,20}?\b${COUNT_TOKEN}\b`,
  'gi',
);

function countMismatch(text, re, authoritative) {
  if (authoritative === null || authoritative === undefined) return false;
  const matches = [...String(text).matchAll(re)];
  return matches.some((match) => {
    // Group 1 is the once/twice form, group 2 the "<n> times" form.
    const stated = countOf(match[1] || match[2] || '');
    return Number.isFinite(stated) && stated !== authoritative;
  });
}

export function addsUnsupportedContactCount(text, support) {
  const t = String(text || '').trim();
  if (!t) return false;
  return countMismatch(t, CONTACT_COUNT_RE, support?.contactAttempts)
    || countMismatch(t, FOLLOW_UP_COUNT_RE, support?.followUps);
}

// ── The findings layer's own obligation (rule 27 + rules 41/47 upstream) ────
//
// EVERYTHING ABOVE IS A DOWNSTREAM SAFETY NET, AND A SAFETY NET IS NOT A
// LICENCE. prb_mt0puwtj_1r7vrh produced a DIAGNOSIS_FINDING whose own text
// read "... once he confirmed it" — but the evidence showed only that the
// agency ASKED whether he was selling. The prospect confirmed nothing; the
// probe never replies. That false relationship was persisted as authoritative,
// and DIAGNOSIS_FINDINGS is the layer everything downstream is required to
// trust. Personalisation quietly rewriting it into something plausible would
// leave the bad finding sitting in the sheet, still authoritative, still wrong
// — so the fix has to be here, at the point the finding is written.
//
// THIRD PERSON, AND THAT IS THE WHOLE DIFFERENCE. Findings are written
// analytically, about "the enquirer" / "he" / "the buyer"; the email is
// written in the enquirer's own voice, as "I". So the downstream prospect-
// reply guard in lib/probe-personalisation.mjs is deliberately FIRST-PERSON
// only — "the vendor was already engaging with your agency as a buyer" is
// correct, pinned copy there and must never be flagged. Here the subject set
// is the analytic one, and applying either lexicon in the other layer would
// break real copy. Kept as two functions on purpose.
//
// RESPONSE verbs only, never DECLARATION verbs. "The enquiry declared a
// property to sell" and "he said in his enquiry that he had a place to sell"
// are the probe facts every finding is built from. What cannot be invented is
// the prospect ANSWERING something: confirming, replying, coming back, saying
// yes.
const FINDING_PROSPECT_SUBJECT = String.raw`(?:the\s+)?(?:enquirer|buyer|applicant|prospect|caller|vendor|seller|lead)|\bhe\b|\bshe\b|\bthey\b`;
const PROSPECT_RESPONSE_VERB = String.raw`confirm(?:ed|s|ing)?|repl(?:y|ied|ies|ying)|respond(?:ed|s|ing)?|answer(?:ed|s|ing)?|came\s+back|got\s+back|said\s+yes|agreed|acknowledg(?:ed|es)`;

const FINDING_INVENTED_RESPONSE = new RegExp(
  String.raw`\b(?:once|after|when|then|so)\b[^.!?]{0,24}\b(?:${FINDING_PROSPECT_SUBJECT})\b[^.!?]{0,16}\b(?:${PROSPECT_RESPONSE_VERB})\b`
  + String.raw`|\b(?:${FINDING_PROSPECT_SUBJECT})\b\s+(?:then|duly|promptly|subsequently)\s+(?:${PROSPECT_RESPONSE_VERB})\b`,
  'i',
);

// The clause carrying the invented response, so it can be removed SURGICALLY
// rather than the whole finding being dropped. A finding like "the agency
// asked whether he was selling once he confirmed it" contains a REAL problem
// (they asked for something already declared) welded to a false clause;
// deleting the finding would throw away the genuine commercial point, and
// deleting the clause keeps it. Where stripping leaves nothing, the existing
// finding/evidence gate in lib/probe-diagnosis.mjs drops the row anyway.
const INVENTED_RESPONSE_CLAUSE = new RegExp(
  String.raw`[,;]?\s*\b(?:once|after|when)\b\s+(?:${FINDING_PROSPECT_SUBJECT})\b[^.!?;]{0,24}?\b(?:${PROSPECT_RESPONSE_VERB})\b[^.!?;]{0,12}`,
  'gi',
);

// evidenceRecordsResponse: does this finding's OWN evidence record a genuine
// prospect-side response? Scoped to the finding itself — another finding
// elsewhere cannot license this one.
export function findingInventsProspectResponse(finding) {
  const claim = `${finding?.finding || ''} ${finding?.significance_note || ''}`;
  if (!FINDING_INVENTED_RESPONSE.test(claim)) return false;
  const evidence = String(finding?.evidence || '');
  return !FINDING_INVENTED_RESPONSE.test(evidence)
    && !/\b(?:replied|responded|called\s+back|wrote\s+back|came\s+back|confirmed)\b/i.test(evidence);
}

export function stripInventedProspectResponse(text) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  const stripped = raw.replace(INVENTED_RESPONSE_CLAUSE, '');
  if (stripped === raw) return raw;
  return stripped.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').replace(/[\s,;]+$/, '').trim();
}

// ── The one entry point ─────────────────────────────────────────────────────
//
// Returns the rejection REASON (which is also the key into the caller's repair
// notes) or null. Ordered most-specific first so the correction message names
// the actual problem rather than a symptom of it.
const DETECTORS = [
  ['unknown_call_certainty', claimsKnownContentOfUnknownCall],
  ['unsupported_universal', addsUnsupportedUniversal],
  ['unsupported_contact_count', addsUnsupportedContactCount],
  ['unsupported_prospect_reply', addsUnsupportedProspectResponse],
  ['unsupported_declaration_timing', addsUnsupportedDeclarationTiming],
  ['unsupported_co_occurrence', addsUnsupportedCoOccurrence],
  ['unsupported_causal_link', addsUnsupportedCausalLink],
  ['certainty_upgrade', upgradesPossibilityToCertainty],
  ['unsupported_comparative', addsUnsupportedComparative],
  ['third_party_knowledge', addsUnsupportedThirdPartyKnowledge],
];

export function findUnsupportedRelationship(text, support) {
  const t = String(text || '').trim();
  if (!t) return null;
  for (const [reason, detector] of DETECTORS) {
    if (detector(t, support)) return reason;
  }
  return null;
}

export const RELATIONSHIP_REASONS = DETECTORS.map(([reason]) => reason);

export const _internal = {
  CO_OCCURRENCE_MARKER, AGENCY_OWNED_ANCHOR, DECLARATION_TIMING_PATTERNS,
  VALUE_COMPARATIVE, THIRD_PARTY_KNOWLEDGE, INTERNAL_BELIEF,
  DEFINITE_SELLER_NOUN, POSSIBILITY_HEDGE, CALL_LOCATOR,
};
