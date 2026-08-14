// lib/sales-strategy.mjs — the deterministic NOVUS Sales Strategy Engine.
//
// Transforms GRADE + TIER + OBSERVED EVIDENCE into a salesperson-ready
// strategy. Pure: no I/O, no AI, no randomness, no clock, no external data.
// The same inputs always produce the same outputs.
//
// Position in the pipeline (Source Master §12 core flow):
//   OBSERVATION -> GRADE (grading.mjs) -> TIER (tier.mjs) -> SALES STRATEGY
// Called from lib/observation-recompute.mjs on every recompute pass, never
// cached or frozen: grade and tier can legitimately change while the 4-day
// observation window is open (a genuine follow-up arriving >30 minutes after
// the first attempt moves C -> A), and the strategy must move with them.
//
// STRATEGY, NOT COPY (Source Master §20 vs §21). These eight fields say what
// the eventual outreach must accomplish and emphasise. They are never drafted
// emails or call scripts — the Personalisation Engine (§21, "AI constrained
// by evidence") turns this strategy into actual wording later. Nothing here
// addresses a named person or writes a sentence intended to be sent as-is.
//
// EVIDENCE DISCIPLINE (§19 "Never store only the conclusion", §21
// "AI must not invent behaviour"). Evidence availability differs sharply by
// grade band, and every statement below is built only from evidence that
// band actually has:
//   A-F  human contact occurred — human_lag_hours, follow_up_count and
//        channels_used are meaningful.
//   G    automated acknowledgement only — there is NO human-contact evidence,
//        so nothing in the G strategy may reference lag or follow-ups.
//   H    no meaningful response at all — there is no positive evidence to
//        quote, only its documented absence.
// Where a value is unavailable the text describes the absence rather than
// interpolating a blank (never "First contact took  hours").
//
// next_action is a deterministic RECOMMENDATION string only. It does not
// create, update or model ACTIONS rows — the Outreach / Next-Action Engine
// (§23) remains a separate rules/state machine that consumes this field.

// ── Evidence formatting helpers (pure, absence-safe) ─────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Human-readable duration that never emits a bare unit with no number.
function formatDuration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${round1(hours)} hours`;
  return `${round1(hours / 24)} days`;
}

// Returns a formatted lag string, or null when the lag is genuinely unknown.
function lagPhrase(observation) {
  const h = observation ? observation.human_lag_hours : undefined;
  if (typeof h !== 'number' || !Number.isFinite(h)) return null;
  return formatDuration(h);
}

// "Human contact came 27.4 hours after the probe" — or an explicit statement
// of the unknown when human_lag_hours could not be computed. Only ever used
// for A-F, where human contact is known to have occurred.
function contactClause(observation) {
  const lag = lagPhrase(observation);
  return lag
    ? `Human contact came ${lag} after the probe`
    : 'Human contact occurred, though the exact lag could not be computed from the available evidence';
}

function followUpPhrase(observation) {
  const n = Number(observation ? observation.follow_up_count : 0) || 0;
  if (n === 0) return 'no genuine follow-up attempts';
  return n === 1 ? '1 genuine follow-up attempt' : `${n} genuine follow-up attempts`;
}

// Only mentioned when it adds information (2+ distinct channels).
function channelPhrase(observation) {
  const raw = observation ? observation.channels_used : '';
  const channels = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return channels.length >= 2 ? ` across ${channels.join(', ')}` : '';
}

// G only: the acknowledgement is the sole piece of positive evidence.
function ackClause(observation) {
  const at = observation ? observation.auto_ack_timestamp : '';
  return at
    ? `An automated acknowledgement was sent (${at})`
    : 'An automated acknowledgement was sent';
}

// ── Agency context (§20 inputs) ──────────────────────────────────────────────
// Permitted enrichment ONLY. Never a routing gate, never a qualification
// check, and never used to invent a fact: when the CRM is unknown, the text
// says it is unknown and makes establishing it part of discovery.
function crmDiscoveryClause(agency) {
  const crm = agency && agency.crm_name ? String(agency.crm_name).trim() : '';
  return crm
    ? ` Confirm how ${crm} is configured to handle this and exactly where it hands off to a person.`
    : ' Establish which CRM or system handles enquiries today — that is not currently known.';
}

// ── Per-grade strategy definitions ───────────────────────────────────────────
// Each entry receives the observation evidence and returns the seven text
// fields; demo_type is a fixed deterministic enum value per grade.

const STRATEGY = {
  A: {
    demo_type: 'growth_database',
    build: (o) => ({
      observed_problem:
        `No front-desk deficiency was observed. ${contactClause(o)} with ${followUpPhrase(o)}${channelPhrase(o)}. `
        + 'The gap is not response speed or persistence — it is what happens to the opportunity after the enquiry has been answered.',
      commercial_implication:
        'A front-desk product would be a poor fit here and an easy objection. The commercial upside sits in enquiry and '
        + 'database opportunity that is already being answered but never becomes a market appraisal.',
      sales_focus:
        'Sell the growth and database outcome rather than a fix. Anchor on additional market appraisals generated from '
        + 'opportunity the agency already owns.',
      discovery_focus:
        'Establish what happens to enquiries and past valuations after first contact — who works the lost-valuation list, '
        + 'and whether anyone owns follow-through once the initial conversation ends.',
      email_strategy:
        'Open by crediting the observed response, which disarms the pitch they expect. Pivot to the appraisal and database '
        + 'opportunity, and avoid any implication that their front desk is failing.',
      phone_strategy:
        'Lead with the specific observed behaviour as proof the agency was actually measured, then move immediately to what '
        + 'happens to the enquiry after that first contact. Do not pitch front-desk cover.',
      next_action:
        'Route to Growth outreach: send the growth/database demo and book a call with the owner or MD.',
    }),
  },

  B: {
    demo_type: 'growth_database',
    build: (o) => ({
      observed_problem:
        `${contactClause(o)} with ${followUpPhrase(o)}${channelPhrase(o)}. `
        + 'Response and persistence are both present — first contact is not immediate, but the enquiry was genuinely worked.',
      commercial_implication:
        'The front desk is functioning, so the commercial case rests on the additional opportunity in the existing enquiry '
        + 'and database asset rather than on missed enquiries.',
      sales_focus:
        'Sell the growth and database opportunity built on top of a front desk that already works. Additional market '
        + 'appraisals, not enquiry rescue.',
      discovery_focus:
        'Establish the size and state of the historic valuation and applicant data, and who — if anyone — currently has time '
        + 'to work it alongside live enquiries.',
      email_strategy:
        'Acknowledge the observed response and persistence up front, then frame the opportunity as the enquiries and old '
        + 'records that never reach an appraisal. Do not position this as fixing a failure.',
      phone_strategy:
        'Use the observed behaviour to establish credibility, then move the conversation to the database and the appraisals '
        + 'sitting in it. Keep front-desk capability out of the pitch.',
      next_action:
        'Route to Growth outreach: send the growth/database demo and book a call with the owner or MD.',
    }),
  },

  C: {
    demo_type: 'front_desk_persistence',
    build: (o) => ({
      observed_problem:
        `${contactClause(o)} — fast — but with ${followUpPhrase(o)} after the initial contact attempt. `
        + 'The enquiry was answered quickly and then dropped.',
      commercial_implication:
        'Speed is not the gap; completion is. An enquiry that does not convert on the first exchange is lost silently, and '
        + 'that loss never appears in the agency\'s own reporting.',
      sales_focus:
        'Sell persistence and completion while explicitly crediting their speed. Novus replaces the second and third chase, '
        + 'not the first answer.',
      discovery_focus:
        'Establish who owns an enquiry after the first reply, whether anything chases automatically, and how they would know '
        + 'today that a fast answer never converted.',
      email_strategy:
        'Credit the fast response first — attacking it will lose them immediately. Frame the gap as everything that happens '
        + 'after the first reply.',
      phone_strategy:
        'Open with their own fast response as verified fact, then ask what happens when that first reply gets no answer. Let '
        + 'the absence of follow-up carry the argument.',
      next_action:
        'Route to Core outreach: send the front-desk demo focused on follow-through and book a call.',
    }),
  },

  D: {
    demo_type: 'front_desk_persistence',
    build: (o) => ({
      observed_problem:
        `${contactClause(o)}, inside the working-day window, with ${followUpPhrase(o)}. `
        + 'The enquiry was picked up at a reasonable speed and then not pursued.',
      commercial_implication:
        'The enquiry was answered, so the agency will believe it was handled. The commercial loss is in the enquiries that '
        + 'needed a second or third attempt and never received one.',
      sales_focus:
        'Sell completion and follow-through. Response speed is adequate and should not be the subject of the pitch.',
      discovery_focus:
        'Establish what triggers a second attempt today, who decides an enquiry is dead, and whether anything records that '
        + 'decision.',
      email_strategy:
        'Treat the response speed as acceptable and put the entire emphasis on what happens after the first attempt. Avoid '
        + 'implying they are slow.',
      phone_strategy:
        'Open on the single contact attempt observed and ask what normally happens next. Their answer usually exposes that '
        + 'nothing owns the second attempt.',
      next_action:
        'Route to Core outreach: send the front-desk demo focused on follow-through and book a call.',
    }),
  },

  E: {
    demo_type: 'front_desk_speed',
    build: (o) => ({
      observed_problem:
        `${contactClause(o)} — beyond the 16-hour working threshold — although the enquiry was then genuinely worked with `
        + `${followUpPhrase(o)}${channelPhrase(o)}. The intent to chase is clearly there; the speed is not.`,
      commercial_implication:
        'Persistence proves they value the enquiry, which makes the delay the expensive part: a buyer or vendor who messaged '
        + 'several agents has usually been answered by one of them long before this response lands.',
      sales_focus:
        'Sell response speed and out-of-hours cover, explicitly crediting the persistence they already demonstrate.',
      discovery_focus:
        'Establish what happens to enquiries arriving in the evening and at weekends, who covers them, and how long first '
        + 'response realistically takes when the team is out on viewings.',
      email_strategy:
        'Credit the persistence, then make the delay concrete and commercial — not a criticism of effort but of timing '
        + 'against the other agents the same enquiry reached.',
      phone_strategy:
        'Open by acknowledging they did chase, then focus entirely on the gap before first contact and who is available when '
        + 'the enquiry actually arrives.',
      next_action:
        'Route to Core outreach: send the front-desk demo focused on response speed and out-of-hours cover, and book a call.',
    }),
  },

  F: {
    demo_type: 'front_desk_speed_and_persistence',
    build: (o) => ({
      observed_problem:
        `${contactClause(o)}, beyond the 16-hour working threshold, with ${followUpPhrase(o)}. `
        + 'Both response speed and persistence are weak.',
      commercial_implication:
        'This is the widest front-desk gap short of a complete miss: the enquiry was neither answered in time nor pursued '
        + 'afterwards, so the opportunity was almost certainly lost to whoever replied first.',
      sales_focus:
        'Sell the front desk itself — both halves. Speed of first response and the follow-through that comes after it.',
      discovery_focus:
        'Establish where enquiries land, who is responsible for them out of hours, and what currently happens when the '
        + 'person responsible is on a viewing.',
      email_strategy:
        'State both observed gaps plainly and without accusation, and let the combination do the work. Keep it factual — the '
        + 'evidence is strong enough that pressure is unnecessary.',
      phone_strategy:
        'Open with the specific enquiry and the observed delay, then establish who was supposed to handle it. Cover both the '
        + 'delay and the absent follow-up.',
      next_action:
        'Route to Core outreach: send the front-desk demo covering both response speed and follow-through, and book a call.',
    }),
  },

  G: {
    demo_type: 'front_desk_completion',
    // No human-contact evidence exists for G — nothing here may reference lag,
    // first human touch or follow-up behaviour.
    build: (o) => ({
      observed_problem:
        `${ackClause(o)}, but no human contact occurred on any channel during the observation window. `
        + 'The enquiry was acknowledged and never completed.',
      commercial_implication:
        'The CRM did its job, so the agency may genuinely believe the enquiry was handled. Acknowledgement without '
        + 'completion is the exact distinction Novus exists to close, and it is invisible from inside their own system.',
      sales_focus:
        'Sell completion — the difference between a reply and a booking. Do not attack the CRM that produced the '
        + 'acknowledgement.',
      discovery_focus:
        'Establish who is supposed to pick up an acknowledged enquiry, and whether they can currently tell an acknowledged '
        + 'enquiry apart from a worked one in their reporting.',
      email_strategy:
        'Frame the issue as acknowledgement without completion. Reference the automated reply as evidence and be explicit '
        + 'that their system worked — the follow-through did not.',
      phone_strategy:
        'Open on the automated reply they sent and the human contact that never followed. Position Novus as what sits after '
        + 'the CRM, never as a replacement for it.',
      next_action:
        'Route to Core outreach: send the front-desk demo focused on completion after acknowledgement, and book a call.',
    }),
  },

  H: {
    demo_type: 'front_desk_missed_enquiry',
    // H has NO positive evidence — only the documented absence of any response.
    build: () => ({
      observed_problem:
        'No meaningful response on any channel in the four days after the probe — no human contact, and not even an '
        + 'automated acknowledgement. The enquiry simply sat.',
      commercial_implication:
        'This is the strongest possible front-desk evidence. A genuine enquiry on a real listing produced nothing at all, '
        + 'and the agency has no mechanism to discover that it happened.',
      sales_focus:
        'Sell the missed enquiry itself. The evidence is the pitch — every other capability is secondary to the fact that '
        + 'nothing came back.',
      discovery_focus:
        'Establish where portal enquiries actually land, who monitors that inbox outside office hours, and whether they '
        + 'would ever find out about an enquiry that received no response at all.',
      email_strategy:
        'Lead with the four-day silence as verified fact, stated without accusation. The absence of any reply is the entire '
        + 'argument — do not dilute it with product features.',
      phone_strategy:
        'Open with the specific property and date and the fact that nothing came back on any channel, then ask what should '
        + 'have happened. Let them describe their own gap.',
      next_action:
        'Route to Core outreach: lead with the missed-enquiry evidence, send the front-desk demo and book a call.',
    }),
  },
};

// The eight strategy fields, blank. Used for pending/compromised and any
// unresolved grade — mirrors lib/tier.mjs, which returns 'unclassified'
// rather than forcing a product where the evidence does not support one.
function emptyStrategy() {
  return {
    observed_problem: '',
    commercial_implication: '',
    sales_focus: '',
    discovery_focus: '',
    demo_type: '',
    email_strategy: '',
    phone_strategy: '',
    next_action: '',
  };
}

// { grade, tier, observation, compromised, agency } -> the 8 strategy fields.
//
// grade:       resolved INTELLIGENCE.grade ('A'..'H', 'pending', or any other
//              unresolved value — all non-A-H values yield a blank strategy).
// tier:        the tier.mjs classification. Carried for interface completeness
//              and asserted-consistent below; grade remains the decisive
//              routing signal, exactly as in tier.mjs.
// observation: computeObservation() output (lib/observation.mjs).
// compromised: probe.compromised — takes priority over grade, since a
//              compromised probe's evidence cannot support any strategy.
// agency:      AGENCIES row object or null. Permitted wording enrichment only;
//              never a routing gate and never a source of invented facts.
export function buildSalesStrategy({
  grade,
  tier = '',
  observation = {},
  compromised = false,
  agency = null,
} = {}) {
  if (compromised === true || compromised === 'TRUE' || compromised === 'true') {
    return emptyStrategy();
  }

  const entry = STRATEGY[grade];
  if (!entry) return emptyStrategy();

  // A resolved A-H grade always produces a Core/Growth tier from tier.mjs. If
  // the tier says unclassified anyway, the two layers disagree and no strategy
  // is asserted — the engine never invents a commercial position out of an
  // inconsistent pipeline state.
  if (tier && tier !== 'Core' && tier !== 'Growth') return emptyStrategy();

  const built = entry.build(observation || {});
  return {
    observed_problem: built.observed_problem,
    commercial_implication: built.commercial_implication,
    sales_focus: built.sales_focus,
    discovery_focus: built.discovery_focus + crmDiscoveryClause(agency),
    demo_type: entry.demo_type,
    email_strategy: built.email_strategy,
    phone_strategy: built.phone_strategy,
    next_action: built.next_action,
  };
}
