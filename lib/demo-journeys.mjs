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
// THE HERO IS THE STRONGEST COMMERCIAL FINDING, NOT THE hero_journey.
// hero_journey names the probe's PRIMARY OPERATIONAL shape - it is picked
// upstream from human_contact and the grading engine's own response bands. It
// is not the same question as "what should this agency read first", so the
// hero title is SELECTED here - one of the four fixed lines in HERO_TITLES,
// never authored per agency and never generated - by commercialPriority(),
// from the full findings:
//
//   1. a complete miss                (nothing became a conversation)
//   2. an unprogressed seller         (a declared vendor nobody took anywhere)
//   3. stalled progression            (answered, then nothing carried it on)
//   4. a slow response                (the delay itself is the story)
//
// A response delay only leads the demo when nothing above it is true, or when
// the delay is severe on its own terms. The internal 16-hour Fast/Slow
// boundary the grade uses is deliberately NOT a hero threshold - a prospect
// has no reason to care where our grading engine draws its line, and a
// modest delay must never push a genuinely bigger finding out of the hero.
// The measured delay is still stated - in the hook, the metric strip and the
// observed events - it just stops being the headline when it isn't the story.
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

function responseHours(ctx) {
  const h = parseFloat(ctx?.intelligence?.response_hours);
  return Number.isFinite(h) && h >= 0 ? h : null;
}

// ── which finding leads the demo ─────────────────────────────────────────────

export const COMMERCIAL_PRIORITIES = [
  'complete_miss', 'seller_unprogressed', 'stalled_progression', 'slow_response',
];

// A delay a prospect would call bad on its own terms, with no reference to how
// our grading engine bands response times: the enquiry sat for a full day or
// more. Below that, a delay is evidence inside a bigger story rather than the
// story itself.
export const SEVERE_DELAY_HOURS = 24;

export function delayWasSevere(ctx) {
  const h = responseHours(ctx);
  return h !== null && h >= SEVERE_DELAY_HOURS;
}

// Nobody from the agency actually spoke to this enquiry.
function noHumanConversation(ctx) {
  const contact = text(ctx?.intelligence?.human_contact);
  return contact === 'none' || contact === 'automated_only';
}

// The opportunity stopped short: either the buyer never got a next step at
// all, or there was a single touch and nothing after it.
function progressionStalled(ctx) {
  if (!viewingWasProgressed(ctx)) return true;
  return contactAttempts(ctx) <= 1 && followUps(ctx) === 0;
}

// -> one of COMMERCIAL_PRIORITIES. The hero title, and the slow journey's own
// opening, are chosen from this rather than from hero_journey, so a modest
// delay can never outrank an unworked vendor or an unfinished opportunity.
export function commercialPriority(heroJourney, ctx) {
  const journey = text(heroJourney);
  if (journey === 'complete_miss' || noHumanConversation(ctx)) return 'complete_miss';
  if (hasSellerGap(ctx)) return 'seller_unprogressed';
  // The one case where the delay genuinely IS the strongest thing here.
  if (journey === 'slow_response_gap' && delayWasSevere(ctx)) return 'slow_response';
  if (progressionStalled(ctx)) return 'stalled_progression';
  if (journey === 'slow_response_gap') return 'slow_response';
  return 'stalled_progression';
}

// ── the four hero headlines ──────────────────────────────────────────────────
//
// FOUR FIXED LINES, ONE PER COMMERCIAL PRIORITY. The hero is never authored
// per agency and never generated: commercialPriority() reads the row's own
// findings and names the strongest commercial issue, and that name selects one
// of these four. Same findings in, same headline out, on every rebuild.
//
// A seller opportunity being PRESENT is not enough to win the hero - the
// seller line is chosen only where the unworked vendor is the strongest thing
// in the findings. A complete miss outranks it, and so does a delay severe
// enough to be the story on its own (see commercialPriority above).
export const HERO_TITLES = {
  // Nothing became a conversation.
  complete_miss: 'A real opportunity entered your business and disappeared.',
  // A declared vendor nobody took anywhere.
  seller_unprogressed: 'One enquiry. Two opportunities. Only one was seen.',
  // Answered once, then nothing carried it on.
  stalled_progression: 'You reached out once. Then stopped.',
  // The delay itself is the story.
  slow_response: 'An enquiry with two opportunities was ready. It had to wait.',
};

export function heroTitle(heroJourney, ctx) {
  return HERO_TITLES[commercialPriority(heroJourney, ctx)];
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

// ── shared derivations ───────────────────────────────────────────────────────

// " 23 minutes" / "" - so a probe whose response time was never established
// produces a shorter sentence rather than a blank in the middle of one.
function afterResponseTime(ctx) {
  return ctx.responseTime ? ` ${ctx.responseTime}` : '';
}

// The measured delay as a trailing sentence, for the openings where it is
// EVIDENCE rather than the point.
function delaySentence(ctx) {
  return ctx.responseTime ? ` The first human response came ${ctx.responseTime} later.` : '';
}

// ── CONTEXT -> INTELLIGENCE -> EXECUTION ─────────────────────────────────────
//
// ONE LINE PER STAGE, ON EVERY JOURNEY. This section exists to communicate a
// single idea - NOVUS understands the situation, knows the next move, then
// makes it happen - and the fastest way to lose that idea is to turn it into
// three lists of things a chatbot does. Nothing here is per-journey, because
// the capability is not per-journey.

function novusUnderstands() {
  return take([{
    label: 'Understands the full situation',
    detail: 'Who they are, what they want, the property, their position and what still needs to be established.',
  }], 1);
}

function novusDecides() {
  return take([{
    label: 'Knows the right next move',
    detail: 'Decides what should happen next, what can be handled automatically and what needs the team.',
  }], 1);
}

function novusActs() {
  return take([{
    label: 'Makes it happen',
    detail: 'Takes the next action \u2014 qualifying, following up, booking, updating, routing and escalating as needed.',
  }], 1);
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
    // No transition or scale line: this journey's act-3 heading and scale line
    // are the shell's own defaults, which already say exactly this (with
    // emphasis markup a sheet cell cannot carry). The hero title is derived
    // for every journey by heroTitle(), from the findings.
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

    // Never the hero title again. The title names the finding; this names what
    // it cost, from the same two ordinals.
    reveal: (ctx) => {
      if (!hasSellerGap(ctx)) return 'The enquiry was answered. It was never finished.';
      return sellerWasRecognised(ctx)
        ? 'The seller question was asked once, and nothing was built on the answer.'
        : 'Two opportunities arrived in one enquiry. Only one of them was worked.';
    },

    revealSupport: () => '',
  },

  // ── slow_response_gap ─────────────────────────────────────────────────────
  //
  // PRIMARY STORY: the enquiry did get human attention, but only after a
  // commercially meaningful delay. Where a declared vendor also went
  // unprogressed, or the conversation stopped after the first touch, THAT is
  // the larger finding and it leads - the delay drops into the evidence.
  slow_response_gap: {
    hook: (ctx) => {
      const priority = commercialPriority('slow_response_gap', ctx);
      if (priority === 'seller_unprogressed') {
        return viewingWasProgressed(ctx)
          ? `Your team worked the buying side, but the potential vendor declared in the same enquiry was never progressed.${delaySentence(ctx)}`
          : `A buyer enquiry and a declared potential vendor entered the business together, and neither opportunity was progressed any further.${delaySentence(ctx)}`;
      }
      if (priority === 'stalled_progression') {
        return `Your team did reply, but the opportunity stopped moving after the first contact.${delaySentence(ctx)}`;
      }
      return `Your team eventually worked the opportunity, but only after the prospect had been waiting${afterResponseTime(ctx)} for meaningful human contact.`;
    },

    reveal: (ctx) => {
      if (hasSellerGap(ctx)) {
        return sellerWasRecognised(ctx)
          ? 'The seller opportunity was recognised, and it still never reached a meaningful seller-side next step.'
          : 'The buyer waited - and the potential vendor was never meaningfully progressed.';
      }
      return commercialPriority('slow_response_gap', ctx) === 'stalled_progression'
        ? 'The enquiry was answered. It was never finished.'
        : 'The opportunity was worked. Just later than it needed to be.';
    },

    // Only used where PERSONALISATION produced no commercial consequence of
    // its own - the agency-written sentence always wins.
    revealSupport: (ctx) => (hasSellerGap(ctx)
      ? 'Two commercial opportunities arrived in one enquiry. One waited, and the other never moved at all.'
      : 'Every hour an enquiry waits is an hour it is available to whoever answers first.'),

    scaleLine: () => "The value isn't shaving a few hours off one enquiry. It's removing that delay across evenings, weekends, busy periods and every other moment your team can't get there immediately.",

    transition: () => 'Same enquiry. NOVUS acts while the opportunity is still live.',
  },

  // ── fast_response_stalled_follow_up ───────────────────────────────────────
  //
  // PRIMARY STORY: the speed was genuinely good. What stopped was everything
  // after it. The agency gets full credit for the response before the demo
  // says anything about what did not follow.
  fast_response_stalled_follow_up: {
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
    hook: (ctx) => (ctx.sellerDeclared
      ? 'A genuine buyer enquiry contained a declared potential vendor. Over the observation period, neither became a meaningful conversation.'
      : 'A genuine property enquiry reached your business and never received a meaningful response.'),

    reveal: (ctx) => (ctx.sellerDeclared
      ? "The buyer wasn't progressed. The potential vendor wasn't either."
      : 'The opportunity simply sat there.'),

    revealSupport: (ctx) => (ctx.sellerDeclared
      ? 'Two commercial opportunities entered the business in one enquiry and neither reached a meaningful next step.'
      : ''),

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
    // Derived for every journey from the findings, never from the journey
    // name alone - see commercialPriority().
    headline: heroTitle(heroJourney, ctx),
    hook: journey.hook(ctx),
    reveal: journey.reveal(ctx),
    revealSupport: journey.revealSupport(ctx),
    transition: journey.transition(ctx),
    scaleLine: journey.scaleLine(ctx),
    detected: novusUnderstands(ctx),
    decisions: novusDecides(ctx),
    actions: novusActs(ctx),
    systemicBridge: SYSTEMIC_BRIDGE,
    ctaHeadline: ctaHeadlineFor(ctx.agencyName),
  };
}

export const _internal = {
  JOURNEYS, teamDidClause, sellerClause, take,
  novusUnderstands, novusDecides, novusActs,
  progressionStalled, noHumanConversation,
};
