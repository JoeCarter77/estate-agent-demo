// lib/evidence-summary.mjs — builds INTELLIGENCE.ai_evidence_summary for
// EVERY probe, from everything the pipeline actually observed.
//
// The integration gap this fixes: ai_evidence_summary was only ever written
// by lib/vendor-intent.mjs, and lib/vendor-intent.mjs returns null unless the
// probe carried the Rightmove vendor declaration. So on every non-vendor
// probe the column was permanently blank, and on vendor probes it carried the
// vendor line and nothing else — the Intelligence tab showed an A-H grade and
// little else, even where the communications plainly contained more.
//
// The second gap this fixes: evidence that matched none of the narrow
// deterministic phrase lists (lib/classification.mjs, lib/vendor-intent.mjs)
// was previously discarded entirely. Those phrase lists exist to decide
// CLASSIFICATION — what a message IS — and staying narrow there is correct.
// But a voicemail transcript or an email body that matches no phrase is still
// real, quotable evidence of what the agency did. This module keeps it: every
// human communication is represented in the summary, quoted, whether or not a
// rule fired on it.
//
// It adds NO new columns, NO new grading and NO new claims: it only restates,
// in readable form, values lib/observation.mjs, lib/classification.mjs and
// lib/vendor-intent.mjs already computed, plus verbatim quotes from the
// COMMUNICATIONS rows themselves. The A-H grade is not an input and is never
// affected by anything here.
//
// Structure of the produced string (stable, so lib/diagnosis.mjs can read the
// vendor line back out — see readVendorStatus in lib/vendor-intent.mjs):
//   "Vendor opportunity: <status>. ..."   <- only when a vendor declaration exists
//   "Response: ..."                        <- speed / who responded
//   "Persistence: ..."                     <- attempts, follow-ups, channels
//   "Booking: ..."                         <- booking / proactive-push evidence
//   "Evidence: \"...\" (channel, time); ..."  <- verbatim quotes, oldest first

import { isHumanCommunication } from './classification.mjs';

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

function round(n) {
  return Math.round(Number(n) * 10) / 10;
}

// probe: PROBES row. communications: this probe's COMMUNICATIONS rows, already
// interpreted. observation: computeObservation() output. vendorResult:
// computeVendorOpportunity() output, or null.
// -> a single human-readable string (possibly '' when there is genuinely
//    nothing observed at all).
export function buildEvidenceSummary({ communications, observation, vendorResult }) {
  const parts = [];

  // 1) Vendor opportunity — first, and verbatim from lib/vendor-intent.mjs so
  // the sentence stays byte-stable for readVendorStatus().
  if (vendorResult) parts.push(vendorResult.ai_evidence_summary);

  const humanComms = communications
    .map((c) => ({ ...c, _at: new Date(c.occurred_at) }))
    .filter((c) => !Number.isNaN(c._at.getTime()))
    .sort((a, b) => a._at - b._at);
  const humanOnly = humanComms.filter((c) => isHumanCommunication(c));

  // 2) Response — speed and whether a person was ever involved.
  if (observation.first_human_touch === 'yes') {
    const lag = typeof observation.human_lag_hours === 'number'
      ? ` after ${round(observation.human_lag_hours)}h`
      : '';
    parts.push(`Response: first human contact${lag} (${observation.first_human_touch_at || 'time unknown'}).`);
  } else if (observation.auto_acknowledgement) {
    parts.push(`Response: automated acknowledgement only (${observation.auto_ack_timestamp || 'time unknown'}); no human ever made contact.`);
  } else {
    parts.push('Response: no communication of any kind was observed.');
  }

  // 3) Persistence — attempts and channels, straight from the rollup.
  const persistenceBits = [
    `${observation.contact_attempt_count || 0} contact attempt(s)`,
    `${observation.follow_up_count || 0} follow-up(s)`,
  ];
  if (observation.channels_used) persistenceBits.push(`channels: ${observation.channels_used}`);
  if (observation.voicemail_count) persistenceBits.push(`${observation.voicemail_count} voicemail(s)`);
  if (observation.successful_conversations) persistenceBits.push(`${observation.successful_conversations} live conversation(s)`);
  if (observation.days_chased !== '' && observation.days_chased != null) persistenceBits.push(`chased over ${observation.days_chased} day(s)`);
  parts.push(`Persistence: ${persistenceBits.join(', ')} (${observation.proactive_reactive || 'unknown'}).`);

  // 4) Booking — the per-row proactive_booking_push signal rolled up. This is
  // COMMUNICATIONS.contact_quality, deliberately NOT the probe-level
  // INTELLIGENCE.contact_quality rollup, which is a different field entirely.
  const pushes = humanOnly.filter((c) => String(c.contact_quality || '').trim() === 'proactive_booking_push');
  if (pushes.length > 0) {
    parts.push(`Booking: ${pushes.length} human message(s) actively pushed for a viewing slot or the prospect's availability.`);
  } else if (observation.booking_attempt) {
    parts.push('Booking: a viewing/valuation was raised, but no specific time or availability was ever pushed for.');
  } else if (humanOnly.length > 0) {
    parts.push('Booking: no attempt to book a viewing or valuation was made in any human message.');
  }

  // 5) Evidence — verbatim quotes from the real communications, INCLUDING the
  // ones no deterministic rule matched. This is the part that stops usable
  // evidence being thrown away.
  const quoted = humanOnly
    .map((c) => ({ comm: c, quote: quoteOf(c) }))
    .filter((q) => q.quote);
  if (quoted.length > 0) {
    const shown = quoted.slice(0, MAX_QUOTES)
      .map(({ comm, quote }) => `"${quote}" (${comm.channel || 'unknown channel'}, ${comm.occurred_at || 'unknown time'})`)
      .join('; ');
    const more = quoted.length > MAX_QUOTES ? ` (+${quoted.length - MAX_QUOTES} further human message(s))` : '';
    parts.push(`Evidence: ${shown}${more}.`);
  }

  return parts.filter(Boolean).join(' ');
}
