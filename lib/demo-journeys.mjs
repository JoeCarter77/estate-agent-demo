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
// SUPPORT LEVELS. Every journey the pipeline can emit is authored and
// publishable. Unknown future values are refused outright rather than fudged
// into the nearest shape.

// The seven journeys the pipeline and shared demo shell support.
export const SUPPORTED_HERO_JOURNEYS = [
  'complete_miss',
  'automated_ack_only',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
  'strong_handling_database_opportunity',
  'strong_handling_no_opportunity',
];

// Reviewed, publishable copy.
export const AUTHORED_HERO_JOURNEYS = [
  'complete_miss',
  'automated_ack_only',
  'slow_response_gap',
  'fast_response_stalled_follow_up',
  'weak_seller_qualification',
  'strong_handling_database_opportunity',
  'strong_handling_no_opportunity',
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
  'complete_miss', 'seller_unprogressed', 'stalled_progression', 'slow_response', 'strong_handling',
];

// Under this, the first response is FAST on its own terms. lib/demos.mjs
// imports it to label the first response in the chronology, so the evidence
// and the EXECUTION sentence can never disagree about whether the team was
// quick.
export const FAST_RESPONSE_HOURS = 1;

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
  if (journey.startsWith('strong_handling_')) return 'strong_handling';
  return 'stalled_progression';
}

// ── the five hero headlines ──────────────────────────────────────────────────
//
// FIVE FIXED LINES, ONE PER COMMERCIAL PRIORITY. The hero is never authored
// per agency and never generated: commercialPriority() reads the row's own
// findings and names the strongest commercial issue, and that name selects one
// of these five. Same findings in, same headline out, on every rebuild.
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
  // The evidence supports credit, not a manufactured criticism.
  strong_handling: 'This enquiry shows what good handling looks like.',
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
// three lists of things a chatbot does.
//
// CONTEXT AND INTELLIGENCE ARE THE SAME ON EVERY DEMO. They describe a
// capability, and the capability does not change with the probe. Only
// EXECUTION adapts - because "what NOVUS would have done differently" is only
// meaningful against what actually happened here.
//
// EXECUTION IS BUILT FROM THE ORDINALS, CLAUSE BY CLAUSE, and every clause is
// gated on evidence the probe actually established:
//
//   lead        a measured delay (or no human contact at all) -> "responds
//               instantly"; a genuinely fast first response is CREDITED
//               instead, never overwritten
//   seller      only where the enquiry declared a property to sell and it
//               never reached a valuation. Recognition that DID happen is
//               acknowledged before the progression clause
//   booking     only where the buyer never reached a specific slot or booking
//   persistence the alternative to booking, where a slot WAS reached and
//               nothing carried the conversation on
//
// So a probe where the team answered fast, worked both sides and booked the
// viewing produces a short, non-critical sentence rather than an invented
// weakness.

function novusUnderstands() {
  return take([{
    label: 'Understands the full enquiry',
    detail: "Who they are, why they're enquiring, where they're selling, their current position, and what more needs establishing.",
  }], 1);
}

function novusDecides() {
  return take([{
    label: 'Knows the right next move',
    detail: 'Uses the full context of the enquiry to decide what should happen next - what needs asking, what opportunity should be progressed, and whether NOVUS should act or bring your team in.',
  }], 1);
}

// A buyer who was given a specific slot or an actual booking does not need
// NOVUS to "work towards booking" - saying so would criticise something the
// agency did well.
const BOOKING_REACHED = new Set(['slot_offered', 'booked']);

// -> the EXECUTION sentence for THIS probe. Pure: same ordinals in, same
// sentence out, on every rebuild and on every read.
export function executionDetail(ctx) {
  const clauses = [];

  // 1. SPEED. The measured lag decides which of the two leads, and a fast
  //    response is credited rather than replaced.
  const hours = responseHours(ctx);
  const answeredFast = hours !== null && hours < FAST_RESPONSE_HOURS;
  clauses.push(answeredFast
    ? 'Keeps the speed your team already showed'
    : 'Responds instantly');

  // 2. THE SELLER SIDE. Only where a vendor was declared and never reached a
  //    valuation, and worded from whether the team engaged with it at all.
  if (hasSellerGap(ctx)) {
    if (sellerWasRecognised(ctx)) {
      clauses.push('picks up the seller position your team identified');
      clauses.push('keeps progressing it towards a valuation');
    } else {
      clauses.push('asks the right questions across both the buyer and seller opportunity');
      clauses.push('progresses the seller towards a valuation');
    }
  }

  // 3. THE APPOINTMENT, or 4. PERSISTENCE - never both. Where the buyer never
  //    reached a specific slot, "works towards booking" already carries the
  //    idea of keeping going; adding a follow-up clause on top only makes the
  //    sentence longer. Persistence is therefore the clause for the case where
  //    a slot WAS reached and nothing carried it on.
  const bookingReached = BOOKING_REACHED.has(viewingProgression(ctx));
  if (!bookingReached) {
    clauses.push('works towards booking the appropriate next step directly into your calendar');
  } else if (progressionStalled(ctx)) {
    clauses.push("keeps following up so the opportunity doesn't stop moving");
  }

  // Nothing was left unprogressed: the sentence says what NOVUS does next
  // rather than manufacturing a gap to fill.
  if (clauses.length === 1) {
    clauses.push('carries the opportunity through to its next step and keeps your team in the loop');
  }

  const last = clauses.pop();
  return `${clauses.join(', ')}, and ${last}.`;
}

function novusActs(ctx) {
  return take([{
    label: 'Makes it happen',
    detail: executionDetail(ctx || {}),
  }], 1);
}

// The three stages for one probe, in the shape the demo row stores them.
// Exported because lib/demos.mjs derives them on the way OUT as well as
// freezing them on the way in - see toRenderReady().
export function buildNovusStages(ctx) {
  return {
    detected: novusUnderstands(ctx),
    decisions: novusDecides(ctx),
    actions: novusActs(ctx),
  };
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

  automated_ack_only: {
    hook: (ctx) => (ctx.sellerDeclared
      ? 'An automated acknowledgement was sent, but the buyer and potential seller did not become a human conversation during the observation period.'
      : 'An automated acknowledgement was sent, but the enquiry did not become a human conversation during the observation period.'),
    reveal: (ctx) => (ctx.sellerDeclared
      ? 'The message arrived. Neither opportunity was progressed by a person.'
      : 'The message arrived. The opportunity was not progressed by a person.'),
    revealSupport: () => '',
    scaleLine: () => "The value isn't one acknowledgement. It's making sure every live enquiry reaches the right next step.",
    transition: () => 'Same enquiry. NOVUS turns acknowledgement into progress.',
  },

  strong_handling_database_opportunity: {
    hook: () => 'Your team responded, understood the wider opportunity and moved the enquiry forward.',
    reveal: () => 'This part worked. The opportunity is to make that standard consistent across every enquiry.',
    revealSupport: () => '',
    scaleLine: () => 'The value is making strong handling repeatable across every branch, channel and busy period.',
    transition: () => 'Same standard. NOVUS helps make it consistent.',
  },

  strong_handling_no_opportunity: {
    hook: () => 'Your team responded and moved the enquiry to a strong next step.',
    reveal: () => 'This part worked. The opportunity is to make that standard consistent across every enquiry.',
    revealSupport: () => '',
    scaleLine: () => 'The value is making strong handling repeatable across every branch, channel and busy period.',
    transition: () => 'Same standard. NOVUS helps make it consistent.',
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
    ...buildNovusStages(ctx),
    systemicBridge: SYSTEMIC_BRIDGE,
    ctaHeadline: ctaHeadlineFor(ctx.agencyName),
  };
}

export const _internal = {
  JOURNEYS, teamDidClause, sellerClause, take,
  novusUnderstands, novusDecides, novusActs, executionDetail,
  progressionStalled, noHumanConversation,
};

// ── THE READING ──────────────────────────────────────────────────────────────
//
// WHAT THE DEMO IS ARGUING. Not "you missed a seller". The claim is that one
// ordinary enquiry contained more context than it appeared to, that NOVUS can
// separate what is KNOWN from what is still UNCLEAR, and that it can act on
// the difference. The single enquiry is the proof point; the product is the
// same reading applied to every signal in the agency.
//
// SO THIS FILE NEVER ACCUSES. It reports what the enquiry contained, what the
// conversation established, what it did not, and what would usefully happen
// next. Where the evidence credits the team it says so first. There is no
// grade here, no lost revenue, no "you should have" - an owner who starts
// arguing with the methodology has stopped reading about their own agency.
//
// NOTHING BELOW IS AUTHORED PER AGENCY. Every line is SELECTED from ordinals
// the DEMOS row already carries, the same way heroTitle() is, so the same
// evidence always produces the same words and a row compiled months ago serves
// its own reading with no recompile.

// ── the three facts that are true of EVERY probe ─────────────────────────────
//
// These are properties of the ENQUIRY WE SENT, not of the agency, so they are
// constants rather than columns: api/novus/probe.js stamps the same vendor
// declaration onto every Rightmove probe, and every probe is submitted from
// the same contact identity.
//
// THE ADDRESS IS THE THING TO BE CAREFUL WITH. An address was supplied with
// the enquiry and it is in Billericay. That is ALL it establishes. It is NOT
// known to be the property being sold - lib/probe-personalisation.mjs holds
// the same rule for the same reason: there is no seller-property address
// anywhere in the data model, so asserting one invents a fact. An agency
// forty miles away that reads "Billericay" as "a valuation outside my patch"
// has been told something we never actually knew, and the correct
// intelligence is to say the relevance is unresolved and ask.
export const ENQUIRY_CONSTANTS = {
  // api/novus/probe.js: 'Declared: has a property to sell, yes, it is not yet
  // on the market'.
  sellerValue: 'Property to sell',
  sellerLabel: 'Not yet on the market',
  // The contact address supplied with the enquiry, and nothing more than that.
  locality: 'Billericay',
  addressLabel: 'Address supplied with the enquiry',
  // lib/demos.mjs OBSERVATION_DAYS - how long we watched before closing.
  observationDays: 4,
};

// ── formatting the row's own numbers ─────────────────────────────────────────

// '£425,000.00' -> '£425k'. Scale, at a glance, for the BUYER enquiry - the
// one place this figure is allowed to appear. It is never attached to the
// declared sale; see lib/demos.mjs on why that claim can never be made.
export function shortPrice(price) {
  const raw = text(price);
  if (!raw) return '';
  const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return raw;
  if (n >= 1e6) return `£${String(Number((n / 1e6).toFixed(2)))}m`;
  if (n >= 1000) return `£${Math.round(n / 1000)}k`;
  return `£${Math.round(n)}`;
}

function londonParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  // '24:07' is a valid en-GB rendering of midnight; the clock the agency
  // recognises is 00:07.
  const hour = fmt.hour === '24' ? '00' : fmt.hour;
  return { day: `${fmt.year}-${fmt.month}-${fmt.day}`, clock: `${hour}:${fmt.minute}`, hour: parseInt(hour, 10) };
}

// A response measured in seconds either side of zero. Ten live rows carry a
// small NEGATIVE response_hours - the reply and the enquiry are stamped within
// the same minute and the arithmetic falls the wrong side of zero - and every
// one of them is an agency that answered essentially immediately. Anything
// further below zero than that is not something we can characterise, so it
// produces no timing claim at all rather than a guess.
const INSTANT_TOLERANCE_HOURS = 1 / 60;

// Long enough that "10.4 hours" and "09:47 the next morning" describe
// materially different agencies; short enough that a reply an hour after a
// late-evening enquiry is still read as part of the same evening.
const SAME_SESSION_HOURS = 6;

// WHEN THE REPLY ACTUALLY LANDED, ON A CLOCK.
//
// THIS IS THE SINGLE MOST IMPORTANT FAIRNESS RULE ON THE PAGE. Every probe is
// submitted late in the evening - the live set runs 20:00 to 00:22 - so the
// median "10.4 hours" is an agency replying at about nine the following
// morning. Reported as a duration that reads as a failure; reported as a
// clock time it reads as what it is, which is the next working morning.
// The demo reports the clock.
//
// -> { clock, phrase, hours } | null
export function replyMoment(ctx) {
  const at = text(ctx?.enquiryAt);
  const hours = parseFloat(ctx?.intelligence?.response_hours);
  if (!at || !Number.isFinite(hours)) return null;
  const sent = new Date(at);
  if (Number.isNaN(sent.getTime())) return null;
  if (hours < -INSTANT_TOLERANCE_HOURS) return null;

  const safeHours = Math.max(hours, 0);
  const sentParts = londonParts(sent);
  const replyParts = londonParts(new Date(sent.getTime() + safeHours * 3600 * 1000));
  const days = Math.round(
    (Date.parse(`${replyParts.day}T00:00:00Z`) - Date.parse(`${sentParts.day}T00:00:00Z`)) / 86400000,
  );

  // A probe sent at 23:36 and answered at 00:39 has crossed a calendar day
  // without crossing a night. The phrase describes the reply an owner would
  // recognise, not the date arithmetic.
  let phrase = '';
  if (days <= 0) phrase = 'the same evening';
  else if (days === 1 && replyParts.hour < 5) phrase = 'the same night';
  else if (days === 1) phrase = replyParts.hour < 12 ? 'the next morning' : 'the next day';
  else phrase = `${days} days later`;

  return { clock: replyParts.clock, phrase, hours: safeHours };
}

// ── what the conversation did and did not settle ─────────────────────────────

const VIEWING_VALUE = {
  mentioned: 'Viewing raised',
  invited: 'Viewing invited',
  availability_requested: 'Availability requested',
  slot_offered: 'A slot was offered',
  booked: 'Viewing booked',
};

const SELLER_HANDLING = {
  asked_position: { value: 'Sale position raised', label: 'Your team asked about it' },
  acknowledged: { value: 'Sale acknowledged', label: 'Noted in the reply' },
  valuation_offered: { value: 'Valuation offered', label: 'The sale side was progressed' },
  valuation_booked: { value: 'Valuation booked', label: 'The sale side was progressed' },
};

// ── SECTION 1: the factual record ────────────────────────────────────────────
//
// Three lines at most, chronological, times only. It is the EVENT record, not
// the analysis - everything the demo concludes from it happens one section
// later, so nothing here is characterised as good or bad.
export function enquiryTimeline(ctx = {}) {
  const out = [];
  // Just "Enquiry sent". Which portal it came through belongs to the listing,
  // and the listing card beside this already says so.
  const sent = text(ctx?.enquiryTime);
  if (sent) out.push({ mark: sent, text: 'Enquiry sent' });

  const attempts = contactAttempts(ctx);
  const channels = text(ctx?.channelWords);

  if (noHumanConversation(ctx)) {
    out.push({
      mark: `${ENQUIRY_CONSTANTS.observationDays} days`,
      text: 'No human reply recorded while we were watching',
    });
    return out;
  }

  // THE TIMELINE IS A CHRONOLOGY, so it reports the CLOCK the reply landed
  // on. The elapsed duration is section two's business - which is also what
  // keeps the same number off the page twice. The day phrase is added only
  // once enough of the night has passed for it to mean anything.
  const moment = replyMoment(ctx);
  const responseTime = text(ctx?.responseTime);
  if (moment) {
    out.push({
      mark: moment.clock,
      text: moment.hours >= SAME_SESSION_HOURS ? `First human reply, ${moment.phrase}` : 'First human reply',
    });
  } else if (responseTime) {
    out.push({ mark: responseTime, text: 'First human reply' });
  } else {
    out.push({ mark: 'Under a minute', text: 'First human reply' });
  }

  if (attempts >= 2) {
    out.push({
      mark: `${attempts} in total`,
      text: channels ? `Contact attempts, by ${channels}` : 'Contact attempts',
    });
  }
  return out;
}

// ── SECTION 2a: what NOVUS picked up ─────────────────────────────────────────
//
// FOUR TO SIX. Candidates are in reading order and a fact does not appear
// merely because the column is populated: the response signal is only carried
// here when the timing is genuinely notable, because the timeline in section
// one has already reported it, and a demo that says the same number twice has
// spent two beats on one idea.
const MAX_SIGNALS = 6;

export function readingSignals(ctx = {}) {
  const out = [];
  const push = (item) => { if (item && out.length < MAX_SIGNALS) out.push(item); };

  const price = shortPrice(ctx?.price);
  if (price) push({ value: price, label: 'Buyer enquiry' });

  // The signal that changes the reading of the enquiry, and the only one the
  // page gives the accent to.
  if (ctx?.sellerDeclared) {
    push({ value: ENQUIRY_CONSTANTS.sellerValue, label: ENQUIRY_CONSTANTS.sellerLabel, tone: 'accent' });
  }

  // Timing, only where it is the story rather than the record: no reply at
  // all, an immediate one, or a delay long enough to be remarkable on its own.
  const moment = replyMoment(ctx);
  const responseTime = text(ctx?.responseTime);
  if (noHumanConversation(ctx)) {
    push({
      value: 'No reply',
      label: `Across the ${ENQUIRY_CONSTANTS.observationDays}-day window`,
      tone: 'open',
    });
  } else if (moment && moment.hours < FAST_RESPONSE_HOURS) {
    push({ value: responseTime || 'Under a minute', label: 'Human response' });
  }
  // A longer wait is NOT repeated here. Section one has already reported the
  // clock time the reply landed on, and saying it twice spends a second beat
  // on one fact - which on a late-evening enquiry is usually just the next
  // working morning anyway.

  // What the team did with it. The seller side leads where it was engaged,
  // because that is the less common thing to have done.
  const recognition = sellerRecognition(ctx);
  if (SELLER_HANDLING[recognition]) push(SELLER_HANDLING[recognition]);

  const progression = viewingProgression(ctx);
  if (VIEWING_PROGRESSED.has(progression)) {
    push({ value: VIEWING_VALUE[progression] || 'Viewing progressed', label: 'The buyer was given a next step' });
  }

  const attempts = contactAttempts(ctx);
  const channels = text(ctx?.channelWords);
  if (attempts >= 2) {
    push({ value: `${attempts} attempts`, label: channels ? `By ${channels}` : 'To reach the enquirer' });
  } else if (progression === 'mentioned') {
    push({ value: 'Viewing raised', label: 'No time was put forward', tone: 'open' });
  } else if (attempts === 1 && followUps(ctx) === 0) {
    // The enquiry got an answer and nothing carried it on. Stated as the
    // record shows it - not as a failure, and not as a number of hours.
    push({ value: 'Answered once', label: 'No further contact recorded', tone: 'open' });
  }

  return out;
}

// ── SECTION 2b: what is still unresolved ─────────────────────────────────────
//
// TWO OR THREE, AND ONLY WHAT THE CONVERSATION GENUINELY LEFT OPEN. An agency
// that already asked about the sale position is not told it failed to ask -
// the item stays (we never answered) but its note credits them for asking.
// This is the half of the section that makes NOVUS look like it is reading
// rather than pattern-matching, so it must never claim something is unknown
// that the communication history settled.
//
// Each item carries `ask`: the same question in the words NOVUS would
// actually use in a message, which is what section three sends.
const MAX_UNRESOLVED = 3;

function unresolvedCandidates(ctx) {
  const items = [];
  const recognition = sellerRecognition(ctx);
  const progression = viewingProgression(ctx);

  if (noHumanConversation(ctx)) {
    items.push({
      text: 'Is the buyer still actively looking?',
      note: 'No human reply was recorded, so this was never established.',
      // Every ask is written in the AGENCY'S voice, because section three
      // sends it on their behalf.
      ask: 'Are you still looking at the property?',
      key: 'nothing_established',
    });
  }

  // THE BILLERICAY QUESTION. An address was supplied. Whether it is the
  // property being sold is exactly the thing nobody established, and it is
  // the difference between a valuation worth having and one outside the patch.
  if (ctx?.sellerDeclared && !SELLER_PROGRESSED.has(recognition)) {
    items.push({
      text: 'Is the supplied address the property being sold?',
      note: SELLER_RECOGNISED.has(recognition)
        ? 'Your team raised the sale. The answer never came back.'
        : '',
      ask: "Is the supplied address the property you're looking to sell?",
      key: 'sale_address',
    });
  }

  if (ctx?.sellerDeclared) {
    items.push({
      text: 'Does the purchase depend on selling first?',
      note: '',
      ask: 'Would the purchase depend on selling that first?',
      key: 'chain',
    });
  }

  if (!noHumanConversation(ctx) && !VIEWING_PROGRESSED.has(progression)) {
    items.push({
      text: 'Was the buyer progressed to the strongest available next step?',
      note: progression === 'mentioned'
        ? 'A viewing was mentioned, but no time was put forward.'
        : '',
      ask: 'Would it help to get you in for a look round?',
      key: 'viewing_intent',
    });
  }

  items.push({
    text: 'What timescale are they working towards?',
    note: '',
    ask: 'And roughly what timescale are you working towards for the move?',
    key: 'timing',
  });

  return items;
}

export function readingUnresolved(ctx = {}) {
  return unresolvedCandidates(ctx).slice(0, MAX_UNRESOLVED);
}

// ── SECTION 2c: crediting the team ───────────────────────────────────────────
//
// MORE THAN HALF THESE AGENCIES ARE GOOD ONES, and a strong operator told what
// they missed before they are told what they did starts evaluating our
// methodology instead of their own opportunity. So where the evidence
// genuinely credits them it is stated first, in their own numbers, and it is
// BLANK rather than invented where there is nothing true to say - a
// manufactured compliment costs more credibility than no compliment at all.
//
// A reply quick enough that an owner would call it good on its own terms, with
// no reference to where the grading engine draws its bands.
const PROMPT_RESPONSE_HOURS = 4;

export function readingCredit(ctx = {}) {
  const clauses = [];
  const moment = replyMoment(ctx);
  const responseTime = text(ctx?.responseTime);
  if (moment && moment.hours <= PROMPT_RESPONSE_HOURS) {
    clauses.push(responseTime ? `came back in ${responseTime}` : 'came back within minutes');
  }
  const attempts = contactAttempts(ctx);
  if (attempts >= 3) clauses.push(`went back ${attempts} times`);
  else if (attempts === 2) clauses.push('followed up again');
  if (viewingWasProgressed(ctx)) clauses.push('moved the buyer towards a viewing');
  if (SELLER_PROGRESSED.has(sellerRecognition(ctx))) clauses.push('opened the valuation conversation');
  else if (SELLER_RECOGNISED.has(sellerRecognition(ctx))) clauses.push('picked up the sale position');

  if (clauses.length === 0) return { line: '', strong: false };
  // Three things done well is a sentence; four is an inventory, and an
  // inventory reads as flattery rather than as observation.
  const kept = clauses.slice(0, 3);
  const last = kept.pop();
  const list = [kept.join(', '), last].filter(Boolean).join(' and ');
  return {
    // Two independent things done well is the point at which "handled this
    // well" is a description rather than a courtesy.
    line: kept.length >= 1 ? `Your team handled this well. They ${list}.` : `Your team ${list}.`,
    strong: kept.length >= 1,
  };
}

// ── SECTION 2: the handling, stated as facts ────────────────────────────────
//
// This is the compact answer to "what did you notice?". Every line is gated
// by an observed ordinal or count. Missing evidence produces a shorter list,
// never a guessed fact.
export function readingHandling(ctx = {}) {
  const out = [];
  const responseTime = text(ctx?.responseTime);
  const attempts = contactAttempts(ctx);
  const channels = text(ctx?.channelWords);

  if (noHumanConversation(ctx)) {
    out.push({
      label: 'Response',
      detail: `No human response was recorded during the ${ENQUIRY_CONSTANTS.observationDays}-day observation period.`,
    });
  } else if (responseTime) {
    out.push({ label: 'Response', detail: `The first human response came in ${responseTime}.` });
  } else {
    out.push({ label: 'Response', detail: 'A human response was recorded.' });
  }

  if (attempts > 0) {
    out.push({
      label: 'Follow-up',
      detail: `${attempts} contact attempt${attempts === 1 ? '' : 's'}${channels ? ` by ${channels}` : ''}.`,
    });
  }

  const buyer = viewingSentence(ctx);
  if (buyer) out.push({ label: 'Buyer progression', detail: buyer });

  const seller = sellerSentence(ctx);
  if (seller) out.push({ label: 'Seller recognition', detail: seller });

  return out.slice(0, 5);
}

// ── SECTION 3: why the unresolved context matters ──────────────────────────
//
// No revenue number, probability or outcome is inferred here. The copy only
// translates the observed state into the practical questions an agency could
// or could not answer about seriousness, timing and the next step.
export function readingCommercialMeaning(ctx = {}, handledWell = false) {
  if (handledWell && !hasSellerGap(ctx) && !progressionStalled(ctx) && !delayWasSevere(ctx)) {
    return {
      lead: 'Your team handled this well.',
      body: 'The opportunity is making that standard consistent across every enquiry - not only the ones that happen to be handled this way.',
    };
  }

  if (noHumanConversation(ctx)) {
    return {
      lead: ctx?.sellerDeclared
        ? 'This was not only a buyer enquiry. There was also a potential seller inside it.'
        : 'The enquiry never became a human conversation.',
      body: ctx?.sellerDeclared
        ? 'Without a human response, neither the buyer position nor the potential sale could be understood or progressed.'
        : 'Without a human response, the buyer\'s intent, timing and strongest next step could not be established.',
    };
  }

  if (hasSellerGap(ctx)) {
    const buyerProgress = viewingWasProgressed(ctx)
      ? 'The buyer was progressed'
      : 'The buyer received a response';
    return {
      lead: 'This was not only a buyer enquiry. There was also a potential seller inside it.',
      body: `${buyerProgress}, but key information around the sale and chain was still unknown - making it harder to understand how serious the opportunity was, how quickly it could move, and what the strongest next step should be.`,
    };
  }

  if (progressionStalled(ctx)) {
    return {
      lead: 'The enquiry was answered, but the opportunity stopped short of a clear next step.',
      body: 'That left the buyer\'s intent and timescale unclear, making it harder to know how the opportunity should be progressed.',
    };
  }

  if (delayWasSevere(ctx)) {
    return {
      lead: 'The opportunity was progressed, but only after a meaningful wait.',
      body: 'That delay made it harder to act while the enquiry was at its freshest, even though the later handling was positive.',
    };
  }

  return {
    lead: 'The enquiry was handled positively.',
    body: 'The opportunity is making that level of attention consistent across every enquiry and every channel.',
  };
}

// ── SECTION 3: what NOVUS would do next ──────────────────────────────────────
//
// THREE AT MOST, and every one of them derived from an unresolved item above -
// so the actions can never recommend something the conversation already did.
// The closing action is the one that carries the commercial argument: the work
// continues without the team, and the team is brought in when a person is
// genuinely the better use of the moment.
const MAX_ACTIONS = 3;

const ACTION_FOR = {
  nothing_established: {
    title: 'Open the conversation',
    detail: 'Respond while the enquiry is still live, then establish what is actually needed.',
  },
  sale_address: {
    title: 'Clarify the sale position',
    detail: 'Establish whether the supplied address is the property being sold.',
  },
  chain: {
    title: 'Establish the chain',
    detail: 'Confirm whether the purchase depends on a sale completing first.',
  },
  viewing_intent: {
    title: 'Offer the next step',
    detail: 'Put viewing times in front of them while the interest is still live.',
  },
  timing: {
    title: 'Understand timing',
    detail: 'Find out what timescale they are working towards.',
  },
};

const KEEP_PROGRESSING = {
  title: 'Keep the enquiry progressing',
  detail: 'Continue automatically, and involve your team when human attention becomes the more valuable thing.',
};

export function readingActions(ctx = {}, unresolved = null) {
  const items = unresolved || readingUnresolved(ctx);
  const out = [];
  for (const item of items) {
    if (out.length >= MAX_ACTIONS - 1) break;
    const action = ACTION_FOR[item.key];
    if (action) out.push(action);
  }
  out.push(KEEP_PROGRESSING);
  return out.slice(0, MAX_ACTIONS);
}

// ONE MESSAGE, TWO QUESTIONS. The point is not that NOVUS asks a lot; it is
// that it asks the few questions that unlock the most useful information.
function lowerFirst(value) {
  const v = text(value);
  return v ? v.charAt(0).toLowerCase() + v.slice(1) : '';
}

export function readingMessage(ctx = {}, unresolved = null) {
  const items = (unresolved || readingUnresolved(ctx)).filter((item) => text(item.ask));
  if (items.length === 0) return '';
  const [first, second] = items;
  if (!second) return text(first.ask);
  const tail = /^and\b/i.test(text(second.ask)) ? text(second.ask) : `And ${lowerFirst(second.ask)}`;
  return `${text(first.ask)} ${tail}`;
}

// -> everything the six sections render, from this row's ordinals alone.
// Pure: same evidence in, same reading out, on every request.
export function buildDemoReading(ctx = {}) {
  const unresolved = readingUnresolved(ctx);
  const credit = readingCredit(ctx);
  return {
    timeline: enquiryTimeline(ctx),
    signals: readingSignals(ctx),
    handling: readingHandling(ctx),
    unresolved,
    credit: credit.line,
    handledWell: credit.strong,
    commercialMeaning: readingCommercialMeaning(ctx, credit.strong),
    actions: readingActions(ctx, unresolved),
    message: readingMessage(ctx, unresolved),
  };
}
