// lib/demo-journeys.mjs - the authored content behind each hero_journey.
//
// ONE SHELL, NOT FOUR DEMOS. demo.html renders whatever the DEMOS row carries
// and knows nothing about hero_journey. This file is the only place a journey
// changes what the prospect sees: it turns one probe's real data into the
// copy for the four beats - real case, proof, the NOVUS difference, across the
// agency - which is then frozen onto the row at build time.
//
// THE FOUR BEATS ARE ONE CONTINUOUS SCROLL, NOT FOUR STEPS. Nothing here is
// paced for a prospect clicking "next": every string is written to be read in
// passing, on the way to the next one. Copy that needs a paragraph to land is
// copy this demo cannot carry.
//
// Adding a journey = adding an entry here. It is never a second demo page and
// never a branch in the renderer.
//
// WHAT IS AUTHORED VS WHAT IS DATA. The per-journey strings below are PRODUCT
// copy - what NOVUS understands, decides and does. They are the same for every
// agency on a given journey, and say nothing about a specific agency that its
// own data did not establish. Everything agency-specific (the positive
// observation, the main finding, the commercial consequence, the observed
// events, the evidence) comes from that probe's PERSONALISATION /
// INTELLIGENCE / DIAGNOSIS_FINDINGS rows and is never authored here.
//
// SUPPORT LEVELS. `weak_seller_qualification` is authored and publishable.
// The other three journeys in SUPPORTED_HERO_JOURNEYS have a working, honest
// draft shape so the shell genuinely carries them - building one succeeds but
// returns a warning and leaves the row `draft`, because the copy has not been
// through the same review. Every other hero_journey the pipeline can emit is
// refused outright rather than fudged into the nearest shape.

import { isStoryFinding } from './diagnosis-findings.mjs';

// The four the demo shell supports. Deliberately NOT the same list as
// lib/probe-personalisation.mjs's HERO_JOURNEYS - the pipeline emits seven,
// and the three not listed here have no demo designed for them yet.
export const SUPPORTED_HERO_JOURNEYS = [
  'complete_miss',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
];

// Reviewed, publishable copy. Everything else in SUPPORTED_HERO_JOURNEYS is
// structural draft.
export const AUTHORED_HERO_JOURNEYS = ['weak_seller_qualification'];

// Locked copy, identical on every demo - the brief's own wording.
export const SYSTEMIC_BRIDGE =
  'NOVUS sits alongside your existing team, CRM, portals and calendar - not in place of them.';

// The reason to take the meeting, in one line: this was ONE enquiry, and the
// question the walkthrough answers is where else it is happening.
export function ctaHeadlineFor(agencyName) {
  const name = String(agencyName || '').trim();
  return name
    ? `We found this from one enquiry. See where NOVUS could be finding more opportunity across ${name}.`
    : 'We found this from one enquiry. See where NOVUS could be finding more opportunity across your agency.';
}

function text(value) { return String(value ?? '').trim(); }

// Trim a collection to the shortest form that still lands. The brief is
// explicit: keep the collections short.
function take(items, n = 3) {
  return items.filter((item) => item && text(item.label)).slice(0, n);
}

function topStoryFinding(findings) {
  return (findings || []).find(isStoryFinding) || null;
}

// ── shared derivations ───────────────────────────────────────────────────────

// What NOVUS recognised, for journeys with no seller-specific angle: the
// probe's own top finding plus the facts that make it real. Never more than
// three lines.
function genericDetected(ctx) {
  const finding = topStoryFinding(ctx.findings);
  const out = [];
  if (finding) {
    out.push({ label: finding.finding, detail: finding.evidence });
  }
  if (ctx.sellerDeclared) {
    out.push({
      label: 'The enquiry carried a property to sell',
      detail: 'Declared inside the enquiry itself, alongside the viewing request.',
    });
  }
  if (finding?.significance_note) {
    out.push({ label: 'Why it matters commercially', detail: finding.significance_note });
  }
  return take(out);
}

// The DECIDES beat leads with what NOVUS would actually have done at this
// moment - PERSONALISATION.novus_counterfactual, which is written about this
// probe. The remaining lines are the journey's product decisions.
function withCounterfactual(ctx, decisions) {
  const counterfactual = text(ctx.personalisation?.novus_counterfactual);
  if (!counterfactual) return take(decisions);
  return take([{ label: 'What should have happened here', detail: counterfactual }, ...decisions]);
}

// ── the journeys ─────────────────────────────────────────────────────────────

// ── weak_seller_qualification: the derived clauses ───────────────────────────
//
// The opening has to do three things inside five seconds - name what the team
// genuinely did, name the opportunity nobody worked, and be unmistakably ABOUT
// THIS ENQUIRY. Both halves are built from the two INTELLIGENCE ordinals this
// probe actually carries, never asserted: an agency that only mentioned the
// viewing is not told it progressed one, and a seller position that WAS asked
// about is not described as never raised.

const VIEWING_PROGRESSED = new Set(['invited', 'availability_requested', 'slot_offered', 'booked']);

function teamDidClause(ctx) {
  const attempts = parseInt(ctx.intelligence?.contact_attempts, 10);
  const followedUp = Number.isFinite(attempts) && attempts > 1;
  if (VIEWING_PROGRESSED.has(text(ctx.intelligence?.viewing_progression))) {
    return followedUp
      ? 'Your team followed up and progressed the viewing.'
      : 'Your team responded and progressed the viewing.';
  }
  return followedUp
    ? 'Your team followed up on the buying side.'
    : 'Your team responded on the buying side.';
}

// NEVER "a missed instruction". A declared vendor is an opportunity that was
// not qualified - what it would have become is unknowable, and claiming it is
// the fastest way to lose a sceptical owner.
const SELLER_CLAUSES = {
  none: 'But the potential vendor declared in the same enquiry was never raised.',
  asked_position: 'But the potential vendor declared in the same enquiry was never qualified.',
  acknowledged: 'But the potential vendor declared in the same enquiry was never taken any further.',
};

function sellerClause(ctx) {
  return SELLER_CLAUSES[text(ctx.intelligence?.seller_recognition)]
    || 'But the potential vendor declared in the same enquiry was never qualified.';
}

const JOURNEYS = {
  // ── AUTHORED ──────────────────────────────────────────────────────────────
  weak_seller_qualification: {
    // WHAT THIS ENQUIRY ACTUALLY WAS, in one line. The chronology of what the
    // team then did belongs in beat 2, where the evidence for it sits - this
    // line only has to make the prospect see two opportunities, not one.
    // Anything that would assert a declared vendor falls back to the older,
    // behaviour-only opening when the probe never carried one.
    hook: (ctx) => (ctx.sellerDeclared
      ? 'A buyer enquiry - and a potential seller your process could have identified and progressed.'
      : `${teamDidClause(ctx)} ${sellerClause(ctx)}`),

    reveal: () => "The buyer was worked. The potential vendor wasn't.",

    // UNDERSTANDS - the commercial opportunity, not the message. One line, so
    // the beat reads as comprehension rather than as a feature list. The
    // seller half is only asserted where this probe actually declared one.
    detected: (ctx) => take([
      {
        label: 'Recognises both sides of the enquiry',
        detail: ctx.sellerDeclared
          ? 'Understands the buyer opportunity, the declared seller opportunity, and what information is still missing.'
          : 'Understands the buyer opportunity, anything the enquiry carries beyond it, and what information is still missing.',
      },
    ], 1),

    // DECIDES - that a next action is chosen per opportunity. The list of
    // possible actions is deliberately wider than this one enquiry: the point
    // is that NOVUS picks, not that it always books a viewing.
    decisions: () => ([
      {
        label: 'Chooses the right next action for each opportunity',
        detail: 'Determines whether the next step should be viewing progression, seller qualification, valuation, follow-up, escalation, or another appropriate action.',
      },
    ]),

    // ACTS - execution AND routing in one beat. No owner chip here: the line
    // is precisely that NOVUS decides which of the two it is.
    actions: () => ([
      {
        label: 'Carries out the next step - or brings your team in',
        detail: 'NOVUS takes the appropriate action automatically where it should, and routes the opportunity to the team when human involvement is needed, with the relevant context already captured.',
      },
    ]),
  },

  // ── DRAFT - structural, not yet reviewed copy ─────────────────────────────
  complete_miss: {
    hook: () => 'This enquiry reached your team. Nothing ever came back.',
    reveal: () => 'The enquiry was real. The response never happened.',
    detected: genericDetected,
    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Answer it, immediately', detail: 'An enquiry with no reply is the one gap nothing downstream can recover.' },
      { label: 'Establish what the enquiry actually carried', detail: 'Buyer, seller, or both - before deciding who it belongs to.' },
    ]),
    actions: () => ([
      { owner: 'novus', label: 'Responds while the enquiry is still warm', detail: 'Whatever hour it arrives.' },
      { owner: 'novus', label: 'Qualifies both sides of the enquiry', detail: 'The viewing, and anything they have to sell.' },
      { owner: 'team', label: 'Picks up a conversation already in progress', detail: 'Rather than a cold lead nobody answered.' },
    ]),
  },

  slow_response_gap: {
    hook: (ctx) => (ctx.responseTime
      ? `Your team did respond - ${ctx.responseTime} later. By then the enquiry had been waiting.`
      : 'Your team did respond. By then the enquiry had been waiting.'),
    reveal: () => "The enquiry was answered. It just wasn't answered in time.",
    detected: genericDetected,
    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Respond inside the window that still converts', detail: 'The reply your team wrote, sent when the enquiry landed.' },
      { label: 'Hold the opportunity open until a person is free', detail: 'So the delay costs the enquiry nothing.' },
    ]),
    actions: () => ([
      { owner: 'novus', label: 'Acknowledges and qualifies on arrival', detail: 'Minutes, not the next working day.' },
      { owner: 'novus', label: 'Keeps the conversation alive until handover', detail: 'The enquiry never sits in a queue.' },
      { owner: 'team', label: 'Takes it on with the context already gathered', detail: 'Same handling, no lost hours.' },
    ]),
  },

  fast_response_stalled_follow_up: {
    hook: (ctx) => (ctx.responseTime
      ? `Your team responded in ${ctx.responseTime}. Then the conversation stopped.`
      : 'Your team responded quickly. Then the conversation stopped.'),
    reveal: () => "The first reply happened. The follow-through didn't.",
    detected: genericDetected,
    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Chase the opportunity, not the contact record', detail: 'Until it progresses or is genuinely closed out.' },
      { label: 'Change channel before giving up on it', detail: 'A silent email is not an answer.' },
    ]),
    actions: () => ([
      { owner: 'novus', label: 'Follows up on a real schedule', detail: 'Across phone, email and text, without being asked.' },
      { owner: 'novus', label: 'Progresses whatever the enquiry was for', detail: 'A viewing, a valuation, or both.' },
      { owner: 'team', label: 'Hears about it when it moves', detail: 'Not when someone remembers to check.' },
    ]),
  },
};

// ── support gate ─────────────────────────────────────────────────────────────

// -> { supported, reason?, warning? }. Called before anything is written, so a
// journey with no demo behind it fails loudly at build time rather than
// producing a plausible-looking row for the wrong story.
export function journeySupport(heroJourney) {
  const journey = text(heroJourney);
  if (!journey) {
    return { supported: false, reason: 'PERSONALISATION.hero_journey is blank - this probe has no journey to build a demo from' };
  }
  if (!SUPPORTED_HERO_JOURNEYS.includes(journey)) {
    return {
      supported: false,
      reason: `hero_journey "${journey}" has no demo journey yet (supported: ${SUPPORTED_HERO_JOURNEYS.join(', ')})`,
    };
  }
  if (!AUTHORED_HERO_JOURNEYS.includes(journey)) {
    return {
      supported: true,
      warning: `hero_journey "${journey}" uses draft copy - review it before publishing this demo`,
    };
  }
  return { supported: true };
}

// -> { hook, reveal, detected[], decisions[], actions[], systemicBridge, ctaHeadline }
// Assumes journeySupport() already passed; callers go through
// lib/demos.mjs's buildDemoRow(), which enforces that.
export function buildJourneyContent(heroJourney, ctx) {
  const journey = JOURNEYS[text(heroJourney)];
  if (!journey) throw new Error(`No demo journey content for hero_journey "${heroJourney}"`);
  return {
    hook: journey.hook(ctx),
    reveal: journey.reveal(ctx),
    detected: journey.detected(ctx),
    decisions: journey.decisions(ctx),
    actions: journey.actions(ctx),
    systemicBridge: SYSTEMIC_BRIDGE,
    ctaHeadline: ctaHeadlineFor(ctx.agencyName),
  };
}

export const _internal = { JOURNEYS, genericDetected, teamDidClause, sellerClause, take };
