// lib/demo-journeys.mjs — the authored content behind each hero_journey.
//
// ONE SHELL, NOT FOUR DEMOS. demo.html renders whatever the DEMOS row carries
// and knows nothing about hero_journey. This file is the only place a journey
// changes what the prospect sees: it turns one probe's real data into the
// four beats' copy, which is then frozen onto the row at build time.
//
// Adding a journey = adding an entry here. It is never a second demo page and
// never a branch in the renderer.
//
// WHAT IS AUTHORED VS WHAT IS DATA. The per-journey strings below are PRODUCT
// copy — what NOVUS understands, decides and does. They are the same for every
// agency on a given journey, and say nothing about a specific agency that its
// own data did not establish. Everything agency-specific (the positive
// observation, the main finding, the commercial consequence, the observed
// events, the evidence) comes from that probe's PERSONALISATION /
// INTELLIGENCE / DIAGNOSIS_FINDINGS rows and is never authored here.
//
// SUPPORT LEVELS. `weak_seller_qualification` is authored and publishable.
// The other three journeys in SUPPORTED_HERO_JOURNEYS have a working, honest
// draft shape so the shell genuinely carries them — building one succeeds but
// returns a warning and leaves the row `draft`, because the copy has not been
// through the same review. Every other hero_journey the pipeline can emit is
// refused outright rather than fudged into the nearest shape.

import { isStoryFinding } from './diagnosis-findings.mjs';

// The four the demo shell supports. Deliberately NOT the same list as
// lib/probe-personalisation.mjs's HERO_JOURNEYS — the pipeline emits seven,
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

// Locked copy, identical on every demo — the brief's own wording.
export const SYSTEMIC_BRIDGE =
  'Designed to sit alongside your existing team, CRM, portals and calendar — not replace them.';

export function ctaHeadlineFor(agencyName) {
  const name = String(agencyName || '').trim();
  return name
    ? `We found this from one enquiry. See what NOVUS could uncover across ${name}.`
    : 'We found this from one enquiry. See what NOVUS could uncover across your business.';
}

function text(value) { return String(value ?? '').trim(); }

// Trim a collection to the shortest form that still lands. The brief is
// explicit: keep the collections short.
function take(items, n = 3) {
  return items.filter((item) => item && text(item.label)).slice(0, n);
}

// The first finding of a given type, as ranked by Diagnosis (index 1 = most
// commercially damaging). Returns null rather than inventing one.
function firstFinding(findings, type) {
  return (findings || []).find((f) => f.finding_type === type) || null;
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
// moment — PERSONALISATION.novus_counterfactual, which is written about this
// probe. The remaining lines are the journey's product decisions.
function withCounterfactual(ctx, decisions) {
  const counterfactual = text(ctx.personalisation?.novus_counterfactual);
  if (!counterfactual) return take(decisions);
  return take([{ label: 'What should have happened here', detail: counterfactual }, ...decisions]);
}

// ── the journeys ─────────────────────────────────────────────────────────────

const JOURNEYS = {
  // ── AUTHORED ──────────────────────────────────────────────────────────────
  weak_seller_qualification: {
    hook: (ctx) => (ctx.responseTime
      ? `Your team responded in ${ctx.responseTime} and progressed the viewing. But there was another commercial opportunity inside this enquiry.`
      : 'Your team responded and progressed the viewing. But there was another commercial opportunity inside this enquiry.'),

    reveal: () => "The buyer was handled. The potential instruction wasn't.",

    detected: (ctx) => {
      const opportunity = firstFinding(ctx.findings, 'opportunity') || topStoryFinding(ctx.findings);
      return take([
        ctx.sellerDeclared && {
          label: 'Two opportunities inside one enquiry',
          detail: 'A viewing request, and a declared property to sell — both stated in the same message.',
        },
        {
          label: 'The buying side moved. The selling side did not.',
          detail: buyingVsSellingDetail(ctx),
        },
        opportunity && {
          label: 'An instruction still sitting unconverted',
          detail: opportunity.significance_note || opportunity.evidence,
        },
      ]);
    },

    decisions: (ctx) => withCounterfactual(ctx, [
      {
        label: 'Qualify the seller position before the thread cools',
        detail: 'On the same conversation, while the enquiry is still live — not as a task for next week.',
      },
      {
        label: 'Put a valuation on the table',
        detail: 'A declared vendor inside a buyer enquiry is an instruction opportunity, not just a viewing.',
      },
      {
        label: 'Keep the viewing moving in parallel',
        detail: 'Neither side of the enquiry waits on the other.',
      },
    ]),

    actions: () => ([
      {
        owner: 'novus',
        label: 'Answers the seller question on the same thread',
        detail: 'Same conversation, same day. No second lead record, no hand-off.',
      },
      {
        owner: 'novus',
        label: 'Offers a market appraisal and proposes times',
        detail: 'Booked straight into your calendar when they accept.',
      },
      {
        owner: 'team',
        label: 'Your valuer walks into a qualified appointment',
        detail: 'With the enquiry, the property and the seller position already attached.',
      },
    ]),
  },

  // ── DRAFT — structural, not yet reviewed copy ─────────────────────────────
  complete_miss: {
    hook: () => 'This enquiry reached your team. Nothing ever came back.',
    reveal: () => 'The enquiry was real. The response never happened.',
    detected: genericDetected,
    decisions: (ctx) => withCounterfactual(ctx, [
      { label: 'Answer it, immediately', detail: 'An enquiry with no reply is the one gap nothing downstream can recover.' },
      { label: 'Establish what the enquiry actually carried', detail: 'Buyer, seller, or both — before deciding who it belongs to.' },
    ]),
    actions: () => ([
      { owner: 'novus', label: 'Responds while the enquiry is still warm', detail: 'Whatever hour it arrives.' },
      { owner: 'novus', label: 'Qualifies both sides of the enquiry', detail: 'The viewing, and anything they have to sell.' },
      { owner: 'team', label: 'Picks up a conversation already in progress', detail: 'Rather than a cold lead nobody answered.' },
    ]),
  },

  slow_response_gap: {
    hook: (ctx) => (ctx.responseTime
      ? `Your team did respond — ${ctx.responseTime} later. By then the enquiry had been waiting.`
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

// The evidence line for "the buying side moved, the selling side didn't",
// built from the two INTELLIGENCE ordinals rather than asserted.
function buyingVsSellingDetail(ctx) {
  const progression = text(ctx.intelligence?.viewing_progression);
  const recognition = text(ctx.intelligence?.seller_recognition);
  const buying = {
    mentioned: 'the viewing was raised',
    invited: 'the buyer was invited to view',
    availability_requested: 'viewing availability was requested',
    slot_offered: 'a viewing slot was offered',
    booked: 'the viewing was booked',
  }[progression];
  const selling = {
    none: 'the property to sell was never raised again',
    asked_position: 'their position was asked about and never taken further',
    acknowledged: 'the sale was acknowledged and no valuation was offered',
  }[recognition];
  if (buying && selling) return `On the same enquiry, ${buying} — and ${selling}.`;
  if (buying) return `On the same enquiry, ${buying}, and the sale never progressed with it.`;
  if (selling) return `On the same enquiry, ${selling}.`;
  return 'The viewing progressed and the declared sale did not move with it.';
}

// ── support gate ─────────────────────────────────────────────────────────────

// -> { supported, reason?, warning? }. Called before anything is written, so a
// journey with no demo behind it fails loudly at build time rather than
// producing a plausible-looking row for the wrong story.
export function journeySupport(heroJourney) {
  const journey = text(heroJourney);
  if (!journey) {
    return { supported: false, reason: 'PERSONALISATION.hero_journey is blank — this probe has no journey to build a demo from' };
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
      warning: `hero_journey "${journey}" uses draft copy — review it before publishing this demo`,
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

export const _internal = { JOURNEYS, genericDetected, buyingVsSellingDetail, take };
