// The founding-pilot acquisition test (Sept 2026 commercial reset): one offer,
// three arms. Email 1 earns a reply, email 2 says how, email 3 reveals the
// performance-backed pilot. Emails 2 and 3 are shared; email 1 differs:
//   A1 outcome-led, refund revealed in email 3        (baseline)
//   A2 outcome-led, refund stated in email 1          (vs A1: refund placement)
//   B  probe-led, its own shorter email 1             (vs A1: the probe-led approach as a whole)
// Copy is fixed here: a change is a new preset with a new name, never an edit
// to a campaign that may already have sent. Delays: day 0, +3, +5.

export const FOUNDING_OUTCOME_TYPE = 'FOUNDING_PILOT_OUTCOME';
export const FOUNDING_OUTCOME_UPFRONT_TYPE = 'FOUNDING_PILOT_OUTCOME_UPFRONT';
export const FOUNDING_PROBE_TYPE = 'FOUNDING_PILOT_PROBE';
export const FOUNDING_OUTCOME_NAME = 'NOVUS — Founding Pilot · A1 Outcome-led';
export const FOUNDING_OUTCOME_UPFRONT_NAME = 'NOVUS — Founding Pilot · A2 Outcome-led, refund upfront';
export const FOUNDING_PROBE_NAME = 'NOVUS — Founding Pilot · B Probe-led';

const OUTCOME_SUBJECT = 'Another 10 valuations?';
const PROBE_SUBJECT = 'Quick one {{firstName}}';

// A1/A2 opening (outcome-led).
const OPENING = "Hi {{firstName}},\n\nWhere would an extra 10 valuations over the next few weeks come from at {{agency}}?\n\nChances are you've got years of enquiries and contacts in the CRM, new ones every week, and a team that's flat out dealing with whatever's in front of them.\n\nWe help agencies get more valuations out of what's already there, and take the repetitive work off the team.";

// B opening (probe-led).

const HOOK = "Hi {{firstName}},\n\nIf you could put another 10 valuations in the diary over the next few weeks, without spending more on generating enquiries, would that be of interest?";
const PROBE = "I recently put a test enquiry through on one of your properties, mentioning that I had a house to sell as well.\n\nIt's part of why I thought {{agency}} could be a good fit for what we're working on.";
const ASK = "Worth me sending over a little more detail?\n\nJoe";

const HOW = "Hi {{firstName}},\n\nA bit more on how we'd do it.\n\nNOVUS works alongside your CRM and your team. It looks across your database and the enquiries coming in each week, works out where the real opportunities are and what should happen next, and takes care of the repetitive follow-up that tends to slip when everyone's busy.\n\nMore valuations, and less of your team's time spent on work that goes nowhere.\n\nWorth a quick chat?\n\nJoe";

const REVEAL = "Hi {{firstName}},\n\nLast one from me, and probably the most useful bit.\n\nWe put our money where our mouth is with founding agencies. The pilot targets 10 extra valuations in 60 days, and for every one we fall short, we refund £250 of the fee.\n\nIf that's worth a conversation, just reply and I'll send the details. If not, no problem, and I won't email again.\n\nJoe";

const SOFT_CLOSE = "Hi {{firstName}},\n\nLast one from me.\n\nIf it's useful, I'm happy to show you roughly where the 10 would come from at {{agency}}, and exactly how we'd count them.\n\nJust reply if that's worth 15 minutes. If not, no problem, and I won't email again.\n\nJoe";

const step = (n, delayDays, subject, body) => ({ step: n, delay_days: delayDays, variants: [{ subject, body, disabled: false }] });

export const FOUNDING_OUTCOME_SEQUENCE = Object.freeze({ steps: [
  step(1, 0, OUTCOME_SUBJECT, `${OPENING}\n\nWe're looking for a few founding agencies to start with. Would it be worth me explaining how?\n\nJoe`),
  step(2, 3, '', HOW),
  step(3, 5, '', REVEAL),
] });

export const FOUNDING_OUTCOME_UPFRONT_SEQUENCE = Object.freeze({ steps: [
  step(1, 0, OUTCOME_SUBJECT, `${OPENING}\n\nWe're looking for a few founding agencies to start with, and we back it: £250 back for every valuation we don't hit. Would it be worth me explaining how?\n\nJoe`),
  step(2, 3, '', HOW),
  step(3, 5, '', SOFT_CLOSE),
] });

export const FOUNDING_PROBE_SEQUENCE = Object.freeze({ steps: [
  step(1, 0, PROBE_SUBJECT, `${HOOK}\n\n${PROBE}\n\n${ASK}`),
  step(2, 3, '', HOW),
  step(3, 5, '', REVEAL),
] });

// Shown in Calling Mode when an owner replies to any arm asking for a call.
export const FOUNDING_CALL_SCRIPT = `# Requested call — founding pilot

Hi {{first_name}}, it's Joe from NOVUS. Thanks for coming back to me. Is now still OK for a few minutes?

The short version: we help agencies get more valuations out of the enquiries and contacts they already have, and take the repetitive work off the team. For founding agencies the pilot targets ten extra valuations in 60 days, and we refund £250 of the fee for every one we fall short.

Whether that's realistic depends on your numbers, so can I ask two quick things?
- Roughly how many valuations are you doing a month at the moment?
- Roughly how many enquiries come in, and how does the team decide what to follow up first?

Book a 20-minute discovery meeting (owner or the person who decides on this) to go through it properly. Don't pitch the whole platform on this call, and don't promise the ten before discovery.`;
