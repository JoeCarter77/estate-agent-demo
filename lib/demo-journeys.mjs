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
// copy - what NOVUS understands, decides and does. What they SAY about the
// agency is chosen by that probe's own evidence: every clause below is picked
// from an INTELLIGENCE ordinal (seller_recognition, viewing_progression,
// contact_attempts, channels_used), the measured response time, or the
// probe's own seller declaration. Nothing here asserts behaviour the probe
// did not establish, and everything genuinely agency-specific (the positive
// observation, the main finding, the commercial consequence, the observed
// events, the evidence) still comes from that probe's PERSONALISATION /
// INTELLIGENCE / DIAGNOSIS_FINDINGS rows.
//
// THE SELLER FINDING IS NEVER BURIED. hero_journey names the PRIMARY
// operational story, not the only one worth telling. Where the enquiry
// declared a property to sell and that opportunity never reached a
// seller-side next step, it is carried into the hero and the conclusion of
// whichever journey is running - a slow response and an unworked vendor are
// two findings from one enquiry, and the commercially larger of the two is
// usually the vendor.
//
// SUPPORT LEVELS. All four journeys in SUPPORTED_HERO_JOURNEYS are authored
// and publishable. Every other hero_journey the pipeline can emit is refused
// outright rather than fudged into the nearest shape.

// The four the demo shell supports. Deliberately NOT the same list as
// lib/probe-personalisation.mjs's HERO_JOURNEYS - the pipeline emits seven,
// and the three not listed here have no demo designed for them yet.
export const SUPPORTED_HERO_JOURNEYS = [
  'complete_miss',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
];

// Reviewed, publishable copy.
export const AUTHORED_HERO_JOURNEYS = [
  'complete_miss',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
];

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

// ── the evidence every journey reads ─────────────────────────────────────────
//
// One place, so "did they progress the viewing" and "was the vendor worked"
// can never mean two different things in two different journeys.

const VIEWING_PROGRESSED = new Set(['invited', 'availability_requested', 'slot_offered', 'booked']);

// Everything below valuation_offered leaves the vendor opportunity
// unprogressed - including asked_position, which IS recognition and is never
// described as a miss.
const SELLER_PROGRESSED = new Set(['valuation_offered', 'valuation_booked']);

// The agency did engage with the declared vendor, without taking it anywhere.
const SELLER_RECOGNISED = new Set(['asked_position', 'acknowledged']);

export function viewingProgression(ctx) { return text(ctx?.intelligence?.viewing_progression); }
export function sellerRecognition(ctx) { return text(ctx?.intelligence?.seller_recognition); }

export function viewingWasProgressed(ctx) { return VIEWING_PROGRESSED.has(viewingProgression(ctx)); }

// The finding that outranks the hero_journey when it is true: a declared
// vendor that never reached a seller-side next step.
export function hasSellerGap(ctx) {
  return Boolean(ctx?.sellerDeclared) && !SELLER_PROGRESSED.has(sellerRecognition(ctx));
}

// A seller gap the agency DID engage with. Worded as "recognised, not
// progressed" everywhere - never as ignored.
export function sellerWasRecognised(ctx) {
  return SELLER_RECOGNISED.has(sellerRecognition(ctx));
}

function contactAttempts(ctx) {
  const n = parseInt(ctx?.intelligence?.contact_attempts, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function followUps(ctx) {
  const n = parseInt(ctx?.intelligence?.follow_ups, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── prospect-facing language for the two ordinals ────────────────────────────
//
// The buyer side is stated plainly so the agency gets credit for it, which is
// what makes the seller contrast land instead of reading as an attack.

export const VIEWING_PROGRESSION_SENTENCE = {
  none: 'No clear attempt was made to progress the buyer towards a viewing.',
  mentioned: 'A viewing was mentioned, but no clear next step was offered.',
  invited: 'The buyer was invited to arrange a viewing.',
  availability_requested: "The buyer's availability was asked for, to arrange a viewing.",
  slot_offered: 'A specific viewing slot was offered.',
  booked: 'A viewing was booked.',
};

export const SELLER_OPPORTUNITY_SENTENCE = {
  none: 'The declared property to sell was never acknowledged or explored in any reply.',
  asked_position: 'The seller opportunity was recognised and the position was asked about, but it never reached a valuation or any other seller-side next step.',
  acknowledged: 'The seller opportunity was acknowledged, but it was never taken towards qualification or a valuation.',
  valuation_offered: 'A valuation was offered on the property the buyer had to sell.',
  valuation_booked: 'A valuation was booked on the property the buyer had to sell.',
};

export function viewingSentence(ctx) {
  return VIEWING_PROGRESSION_SENTENCE[viewingProgression(ctx)] || '';
}

export function sellerSentence(ctx) {
  if (!ctx?.sellerDeclared) return '';
  return SELLER_OPPORTUNITY_SENTENCE[sellerRecognition(ctx)]
    || 'The declared property to sell never reached a seller-side next step.';
}

// What NOVUS still does not know at the end of the real conversation - worded
// from what the agency's own messages did or did not establish.
const SELLER_UNKNOWN_DETAIL = {
  none: 'Never raised in any reply',
  asked_position: 'Asked about once, never taken further',
  acknowledged: 'Acknowledged, never qualified',
};

function sellerUnknownDetail(ctx) {
  return SELLER_UNKNOWN_DETAIL[sellerRecognition(ctx)] || 'Never progressed towards a valuation';
}

// ── shared derivations ───────────────────────────────────────────────────────

// The seller line every journey adds to UNDERSTANDS when the enquiry carried a
// vendor nobody progressed. Same shape whichever journey is running, because
// it is the same finding.
function sellerDetectedItem(ctx) {
  if (!hasSellerGap(ctx)) return null;
  return sellerWasRecognised(ctx)
    ? { label: 'A seller opportunity recognised but not progressed', detail: sellerUnknownDetail(ctx) }
    : { label: 'A declared seller opportunity nobody picked up', detail: sellerUnknownDetail(ctx) };
}

// The DECIDES beat leads with what NOVUS would actually have done at this
// moment - PERSONALISATION.novus_counterfactual, which is written about this
// probe. The remaining lines are the journey's product decisions.
function withCounterfactual(ctx, decisions) {
  const counterfactual = text(ctx.personalisation?.novus_counterfactual);
  if (!counterfactual) return take(decisions);
  return take([{ label: 'What should have happened here', detail: counterfactual }, ...decisions]);
}

// " 23 minutes" / "" - so a probe whose response time was never established
// produces a shorter sentence rather than a blank in the middle of one.
function afterResponseTime(ctx) {
  return ctx.responseTime ? ` ${ctx.responseTime}` : '';
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

function teamDidClause(ctx) {
  const followedUp = contactAttempts(ctx) > 1;
  if (viewingWasProgressed(ctx)) {
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
  return SELLER_CLAUSES[sellerRecognition(ctx)]
    || 'But the potential vendor declared in the same enquiry was never qualified.';
}

const JOURNEYS = {
  weak_seller_qualification: {
    // No headline, transition or scale line: this journey's hero heading is
    // derived by the shell from seller_declared, and its act-3 heading and
    // scale line are the shell's own defaults, which already say exactly this
    // (with emphasis markup a sheet cell cannot carry). Left blank so the
    // reference journey renders byte-identically to before it was configured.
    headline: () => '',
    transition: () => '',
    scaleLine: () => '',

    // WHAT THIS ENQUIRY ACTUALLY WAS, in one line. The chronology of what the
    // team then did belongs in beat 2, where the evidence for it sits - this
    // line only has to make the prospect see two opportunities, not one.
    // Anything that would assert a declared vendor falls back to the older,
    // behaviour-only opening when the probe never carried one.
    hook: (ctx) => (ctx.sellerDeclared
      ? 'A buyer enquiry - and a potential seller your process could have identified and progressed.'
      : `${teamDidClause(ctx)} ${sellerClause(ctx)}`),

    reveal: () => "The buyer was worked. The potential vendor wasn't.",
    revealSupport: () => '',

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

  // ── slow_response_gap ─────────────────────────────────────────────────────
  //
  // PRIMARY STORY: the enquiry did get human attention, but only after a
  // commercially meaningful delay. Where a declared vendor also went
  // unprogressed, that is the larger of the two findings and shares the hero -
  // a slow reply is a speed problem, an unworked vendor is a revenue one.
  slow_response_gap: {
    headline: (ctx) => (hasSellerGap(ctx)
      ? 'The enquiry waited. The seller opportunity went nowhere.'
      : 'The enquiry was live. The response came later.'),

    hook: (ctx) => (hasSellerGap(ctx)
      ? `A live buyer enquiry sat waiting${afterResponseTime(ctx)} for a human response - while a declared potential vendor inside it was never meaningfully progressed.`
      : `Your team eventually worked the opportunity, but only after the prospect had been waiting${afterResponseTime(ctx)} for meaningful human contact.`),

    reveal: (ctx) => {
      if (!hasSellerGap(ctx)) return 'The opportunity was worked. Just later than it needed to be.';
      return sellerWasRecognised(ctx)
        ? 'The enquiry waited, and although the seller opportunity was recognised, it never reached a meaningful seller-side next step.'
        : 'The buyer waited - and the potential vendor was never meaningfully progressed.';
    },

    // Only used where PERSONALISATION produced no commercial consequence of
    // its own - the agency-written sentence always wins.
    revealSupport: (ctx) => (hasSellerGap(ctx)
      ? 'Two commercial opportunities arrived in one enquiry. One waited, and the other never moved at all.'
      : 'Every hour an enquiry waits is an hour it is available to whoever answers first.'),

    // UNDERSTANDS - the enquiry as it stood the moment it landed, plus
    // whatever else was inside it that nobody got to.
    detected: (ctx) => take([
      {
        label: 'A live enquiry, the moment it arrived',
        detail: ctx.responseTime ? `The first human response came ${ctx.responseTime} later.` : 'The first human response came later.',
      },
      sellerDetectedItem(ctx),
      viewingWasProgressed(ctx)
        ? { label: 'A buyer worth progressing', detail: viewingSentence(ctx) }
        : { label: 'A buyer still to be progressed', detail: viewingSentence(ctx) },
    ]),

    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Respond inside the window that still converts', detail: 'The reply your team wrote, sent when the enquiry landed.' },
      hasSellerGap(ctx)
        ? { label: 'Qualify the declared seller in the same conversation', detail: 'Not in a later one that never happens.' }
        : { label: 'Hold the opportunity open until a person is free', detail: 'So the delay costs the enquiry nothing.' },
    ]),

    actions: (ctx) => ([
      { owner: 'novus', label: 'Acknowledges and qualifies on arrival', detail: 'Minutes, not the next working day.' },
      ctx.sellerDeclared
        ? { owner: 'novus', label: 'Works both sides while the enquiry is still live', detail: 'The viewing, and the property they said they had to sell.' }
        : { owner: 'novus', label: 'Keeps the conversation alive until handover', detail: 'The enquiry never sits in a queue.' },
      { owner: 'team', label: 'Takes it on with the context already gathered', detail: 'Same handling, no lost hours.' },
    ]),

    scaleLine: () => "The value isn't shaving a few hours off one enquiry. It's removing that delay across evenings, weekends, busy periods and every other moment your team can't get there immediately.",

    transition: () => 'Same enquiry. NOVUS acts while the opportunity is still live.',
  },

  // ── fast_response_stalled_follow_up ───────────────────────────────────────
  //
  // PRIMARY STORY: the speed was genuinely good. What stopped was everything
  // after it. The agency gets full credit for the response before the demo
  // says anything about what did not follow.
  fast_response_stalled_follow_up: {
    headline: (ctx) => (hasSellerGap(ctx)
      ? 'A fast response. Two opportunities left unfinished.'
      : 'A fast response. An unfinished opportunity.'),

    // The speed claim is the MEASURED one where there is one - "quickly" is
    // only used when INTELLIGENCE never established a response time, so the
    // demo can never praise a lag it has the number for.
    hook: (ctx) => (hasSellerGap(ctx)
      ? `Your team got to the buyer${ctx.responseTime ? ` in ${ctx.responseTime}` : ' quickly'} - but the conversation stalled, and the declared seller opportunity was never meaningfully progressed.`
      : `Your team got to the enquiry${ctx.responseTime ? ` in ${ctx.responseTime}` : ' quickly'}, but after the initial contact the opportunity stopped moving.`),

    reveal: (ctx) => {
      if (!hasSellerGap(ctx)) return "The enquiry was answered. It wasn't completed.";
      // Where the buyer side genuinely moved, the contrast IS the finding -
      // it is what makes the seller gap a process problem rather than a
      // capability one.
      return viewingWasProgressed(ctx)
        ? "The viewing was actively progressed. The potential vendor wasn't."
        : 'The enquiry was answered. Neither opportunity was fully progressed.';
    },

    revealSupport: (ctx) => (hasSellerGap(ctx)
      ? 'The buyer received a fast response, but the wider commercial opportunity still stopped short.'
      : 'A fast first reply only converts if something follows it.'),

    detected: (ctx) => take([
      {
        label: ctx.responseTime ? `Answered in ${ctx.responseTime}, then left standing` : 'Answered quickly, then left standing',
        detail: followUps(ctx) > 0
          ? `${followUps(ctx)} follow-up${followUps(ctx) === 1 ? '' : 's'}, and the conversation still never progressed.`
          : 'No genuine follow-up after the first contact.',
      },
      sellerDetectedItem(ctx),
      viewingWasProgressed(ctx)
        ? { label: 'A viewing that was actively worked', detail: viewingSentence(ctx) }
        : { label: 'A viewing that never got its next step', detail: viewingSentence(ctx) },
    ]),

    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Chase the opportunity, not the contact record', detail: 'Until it progresses or is genuinely closed out.' },
      hasSellerGap(ctx)
        ? { label: 'Change channel, and finish the seller question', detail: 'A silent email is not an answer, and one question is not qualification.' }
        : { label: 'Change channel before giving up on it', detail: 'A silent email is not an answer.' },
    ]),

    actions: (ctx) => ([
      { owner: 'novus', label: 'Follows up on a real schedule', detail: 'Across phone, email and text, without being asked.' },
      ctx.sellerDeclared
        ? { owner: 'novus', label: 'Progresses the viewing and the valuation', detail: 'Books what can be booked, and stops when there is a genuine outcome.' }
        : { owner: 'novus', label: 'Progresses whatever the enquiry was for', detail: 'Books what can be booked, and stops when there is a genuine outcome.' },
      { owner: 'team', label: 'Hears about it when it moves', detail: 'Not when someone remembers to check.' },
    ]),

    scaleLine: () => "The value isn't one extra follow-up. It's making sure opportunities don't quietly stop moving across your entire enquiry flow.",

    transition: () => 'Same enquiry. NOVUS keeps the opportunity moving.',
  },

  // ── complete_miss ─────────────────────────────────────────────────────────
  //
  // PRIMARY STORY: no meaningful human progression at all inside the
  // observation window. The hardest-hitting journey, and therefore the one
  // that has to stay strictly factual - an automated acknowledgement is
  // named as automated in beat 2 and is never allowed to read as a response.
  complete_miss: {
    headline: (ctx) => (ctx.sellerDeclared
      ? 'One enquiry. Two opportunities. Neither progressed.'
      : 'One enquiry. No conversation.'),

    hook: (ctx) => (ctx.sellerDeclared
      ? 'A genuine buyer enquiry contained a declared potential vendor. Over the observation period, neither became a meaningful conversation.'
      : 'A genuine property enquiry reached your business and never received a meaningful response.'),

    reveal: (ctx) => (ctx.sellerDeclared
      ? "The buyer wasn't progressed. The potential vendor wasn't either."
      : 'The opportunity simply sat there.'),

    revealSupport: (ctx) => (ctx.sellerDeclared
      ? 'Two commercial opportunities entered the business in one enquiry and neither reached a meaningful next step.'
      : ''),

    // Where a probe somehow carries seller_recognition on this journey, the
    // real evidence is preserved rather than forced into "never recognised".
    detected: (ctx) => take([
      {
        label: ctx.sellerDeclared ? 'Both opportunities in one enquiry' : 'A real enquiry, unanswered',
        detail: ctx.sellerDeclared
          ? 'A buyer to progress, and a declared property to sell'
          : 'Sent through the portal, with a viewing request in it',
      },
      sellerDetectedItem(ctx),
      { label: 'Nothing established about this buyer', detail: 'No qualification, no viewing, no next step' },
    ]),

    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Answer it, immediately', detail: 'An enquiry with no reply is the one gap nothing downstream can recover.' },
      { label: 'Establish what the enquiry actually carried', detail: 'Buyer, seller, or both - before deciding who it belongs to.' },
    ]),

    actions: (ctx) => ([
      { owner: 'novus', label: 'Responds while the enquiry is still warm', detail: 'Whatever hour it arrives.' },
      ctx.sellerDeclared
        ? { owner: 'novus', label: 'Qualifies both sides of the enquiry', detail: 'The viewing, and the property they said they had to sell.' }
        : { owner: 'novus', label: 'Qualifies the buyer and keeps following up', detail: 'Until there is a viewing or a genuine outcome.' },
      { owner: 'team', label: 'Picks up a conversation already in progress', detail: 'Rather than a cold lead nobody answered.' },
    ]),

    scaleLine: () => "The value isn't rescuing one missed enquiry. It's creating a system where live opportunities don't get the chance to disappear unnoticed.",

    transition: () => 'Same enquiry. NOVUS turns arrival into action.',
  },
};

// ── support gate ─────────────────────────────────────────────────────────────

// -> { supported, reason?, warning? }. Called before anything is written, so a
// journey with no demo behind it fails loudly at build time rather than
// producing a plausible-looking row for the wrong story. This is also what
// makes /demo/{slug} fail SAFELY on a bad hero_journey: no row is ever
// compiled, so the link resolves to nothing rather than to another journey's
// narrative.
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

// -> { headline, hook, reveal, revealSupport, transition, scaleLine,
//      detected[], decisions[], actions[], systemicBridge, ctaHeadline }
// Assumes journeySupport() already passed; callers go through
// lib/demos.mjs's buildDemoRow(), which enforces that.
export function buildJourneyContent(heroJourney, ctx) {
  const journey = JOURNEYS[text(heroJourney)];
  if (!journey) throw new Error(`No demo journey content for hero_journey "${heroJourney}"`);
  return {
    headline: journey.headline(ctx),
    hook: journey.hook(ctx),
    reveal: journey.reveal(ctx),
    revealSupport: journey.revealSupport(ctx),
    transition: journey.transition(ctx),
    scaleLine: journey.scaleLine(ctx),
    detected: journey.detected(ctx),
    decisions: journey.decisions(ctx),
    actions: journey.actions(ctx),
    systemicBridge: SYSTEMIC_BRIDGE,
    ctaHeadline: ctaHeadlineFor(ctx.agencyName),
  };
}

export const _internal = {
  JOURNEYS, teamDidClause, sellerClause, take,
  sellerDetectedItem, sellerUnknownDetail,
};
