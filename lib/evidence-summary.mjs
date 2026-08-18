// lib/evidence-summary.mjs — builds INTELLIGENCE.ai_evidence_summary: the
// probe-level narrative of what actually happened, for EVERY probe.
//
// Two things changed here after auditing the live data.
//
// 1. It now reads COMMUNICATIONS.ai_summary. That is an existing, already-
//    populated column (54 of 77 live rows) carrying an analyst-grade sentence
//    per message — "Bulk brochure send from a named mailbox. Does not
//    reference the probe property and offers no appointment.", "directing the
//    enquirer to self-register rather than offering an appointment". Nothing
//    in the pipeline had ever read it; the summary was instead assembled from
//    truncated raw quotes. Where a row carries an ai_summary it is preferred,
//    because it already says what the message MEANT rather than what it said.
//    It is only ever read, never written.
//
// 2. It states what the agency did NOT do (lib/probe-intelligence.mjs), not
//    just what it did. A miss is only asserted where the enquiry established
//    the opportunity and the evidence shows it was not taken.
//
// Structure (stable — lib/diagnosis.mjs reads the first two lines back out):
//   "Vendor opportunity: <status>. ..."   only when the enquiry declared one
//   "Missed: <finding> <finding>"          only when misses are supported
//   "Response: ..." / "Persistence: ..." / "Booking: ..." / "Evidence: ..."

const MAX_QUOTES = 4;
const QUOTE_CHARS = 160;

function textOf(comm) {
  const body = String(comm.body_text || comm.raw_content || comm.transcript || '').trim();
  const subject = String(comm.subject || '').trim();
  if (body && subject) return `${subject} — ${body}`;
  return body || subject;
}

function quoteOf(comm) {
  const text = textOf(comm).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trim()}…` : text;
}

function round(n) { return Math.round(Number(n) * 10) / 10; }

const VENDOR_STATUS_SENTENCE = {
  progressed: 'a valuation or appraisal was actually booked',
  discussed: 'selling or a valuation was discussed but never booked',
  acknowledged: 'the agency acknowledged the sell-side position but took it no further',
  no_evidence: 'no communication ever engaged with it',
};

// { communications, observation, context } -> the narrative string.
// context is computeProbeIntelligenceContext() output; communications are the
// probe's already-interpreted COMMUNICATIONS rows.
export function buildEvidenceSummary({ communications, observation, context }) {
  const parts = [];
  const byId = new Map(communications.map((c) => [c.communication_id, c]));

  // 1) Vendor opportunity — only when the enquiry actually declared one.
  if (context.enquiry.has_property_to_sell) {
    const status = context.vendor_status || 'no_evidence';
    const reviewed = context.assessments.filter((a) => a.human).length;
    parts.push(
      `Vendor opportunity: ${status}. The enquiry declared a property to sell that is not yet on the market; `
      + `across ${reviewed} human communication(s), ${VENDOR_STATUS_SENTENCE[status] || 'the evidence is inconclusive'}.`,
    );
  }

  // 2) What the agency did NOT do.
  if (context.missed_opportunities.length > 0) {
    parts.push(`Missed: ${context.missed_opportunities.map((m) => m.finding).join(' ')}`);
  }

  // 3) Response — speed, and whether it was a real reply at all.
  if (observation.first_human_touch === 'yes') {
    const lag = typeof observation.human_lag_hours === 'number'
      ? ` after ${round(observation.human_lag_hours)}h` : '';
    parts.push(`Response: first genuine human reply${lag} (${observation.first_human_touch_at || 'time unknown'}).`);
  } else if (context.assessments.some((a) => a.human)) {
    // Messages arrived from people, but none of them answered this enquiry —
    // a materially different finding from silence, and one the old summary
    // could not express.
    const sent = context.assessments.filter((a) => a.human).length;
    parts.push(`Response: no genuine reply to this enquiry, despite ${sent} human message(s) being sent.`);
  } else if (observation.auto_acknowledgement) {
    parts.push(`Response: automated acknowledgement only (${observation.auto_ack_timestamp || 'time unknown'}); no human ever made contact.`);
  } else {
    parts.push('Response: no communication of any kind was observed.');
  }

  // 4) Persistence.
  const bits = [
    `${observation.contact_attempt_count || 0} genuine contact attempt(s)`,
    `${observation.follow_up_count || 0} follow-up(s)`,
  ];
  if (observation.channels_used) bits.push(`channels: ${observation.channels_used}`);
  if (observation.voicemail_count) bits.push(`${observation.voicemail_count} voicemail(s)`);
  if (observation.successful_conversations) bits.push(`${observation.successful_conversations} live conversation(s)`);
  if (observation.days_chased !== '' && observation.days_chased != null) bits.push(`chased over ${observation.days_chased} day(s)`);
  parts.push(`Persistence: ${bits.join(', ')} (${observation.proactive_reactive || 'unknown'}).`);

  // 5) Booking.
  if (context.booking_pushed) {
    const n = context.assessments.filter((a) => a.pushes_specific_slot).length;
    parts.push(`Booking: ${n} message(s) pushed a specific slot or asked for the enquirer's availability.`);
  } else if (context.appointment_offered) {
    parts.push('Booking: a viewing/valuation was raised, but no specific time or availability was ever pushed for.');
  } else if (context.assessments.some((a) => a.human)) {
    parts.push('Booking: no viewing or valuation was ever offered.');
  }

  // 6) Evidence — the per-message read. Prefers each row's own ai_summary
  // (what the message meant); falls back to a verbatim quote where no summary
  // exists, so evidence matching no rule is still never discarded.
  const humanAssessments = context.assessments.filter((a) => a.human);
  const lines = humanAssessments
    .map((a) => {
      const comm = byId.get(a.communication_id) || {};
      const label = `${a.channel || 'unknown channel'}, ${a.occurred_at || 'unknown time'}`;
      if (a.ai_summary) return `${a.ai_summary} (${label})`;
      const quote = quoteOf(comm);
      return quote ? `"${quote}" (${label})` : '';
    })
    .filter(Boolean);
  if (lines.length > 0) {
    const shown = lines.slice(0, MAX_QUOTES).join('; ');
    const more = lines.length > MAX_QUOTES ? ` (+${lines.length - MAX_QUOTES} further human message(s))` : '';
    parts.push(`Evidence: ${shown}${more}.`);
  }

  return parts.filter(Boolean).join(' ');
}

// Reads the "Missed:" section back off a stored INTELLIGENCE row, so
// lib/diagnosis.mjs can act on the findings without a new column. Returns ''
// when the row records no misses.
const MISSED_PATTERN = /(?:^|\s)Missed:\s*(.*?)(?=\s(?:Response|Persistence|Booking|Evidence):|$)/s;

export function readMissedFindings(aiEvidenceSummary) {
  const m = MISSED_PATTERN.exec(String(aiEvidenceSummary || ''));
  return m ? m[1].trim() : '';
}
