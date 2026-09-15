// lib/calling-outcomes.mjs — PURE outcome semantics for the calling workflow.
//
// No I/O. Given what the operator classified, this module says:
//   · whether the call counts as connected / owner reached / pitched
//     (derived, never typed in — these are the script-funnel facts)
//   · which follow-up actions the outcome creates, and when
//   · whether the agency becomes terminal (meeting booked / not interested)
//   · whether the lead is suppressed from future calling
//
// The handlers in lib/calling-handlers.mjs apply the plan; this file only
// decides it, so every rule is testable without a repo.

import { addLondonCalendarDays, addLondonWorkingDays, nextLondonWorkingDay } from './london-time.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const at = (value) => (Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null);

export const CALL_OUTCOMES = Object.freeze([
  'NO_ANSWER', 'GATEKEPT', 'OWNER_UNAVAILABLE', 'CALLBACK_REQUESTED', 'MORE_INFO_REQUESTED',
  'NOT_INTERESTED', 'BOOKED_MEETING', 'WRONG_NUMBER', 'NOT_THE_DECISION_MAKER', 'DO_NOT_CALL',
]);

export const OUTCOME_LABEL = Object.freeze({
  NO_ANSWER: 'No answer', GATEKEPT: 'Gatekept', OWNER_UNAVAILABLE: 'Owner unavailable / not in',
  CALLBACK_REQUESTED: 'Callback requested / not right now', MORE_INFO_REQUESTED: 'More information requested',
  NOT_INTERESTED: 'Not interested', BOOKED_MEETING: 'Booked meeting', WRONG_NUMBER: 'Wrong number',
  NOT_THE_DECISION_MAKER: 'Not the decision-maker', DO_NOT_CALL: 'Do not call again',
});

export const NOT_INTERESTED_REASONS = Object.freeze([
  'HAPPY_WITH_CURRENT_PROCESS', 'DOESNT_BELIEVE_PROBLEM_EXISTS', 'DOESNT_NEED_MORE_VALUATIONS',
  'TOO_BUSY_CAPACITY', 'DOESNT_WANT_ANOTHER_SYSTEM', 'AI_AUTOMATION_CONCERN', 'BUDGET_PRICE',
  'TIMING', 'DOESNT_UNDERSTAND_VALUE', 'BAD_FIT', 'WOULDNT_SAY', 'OTHER',
]);
export const MORE_INFO_TYPES = Object.freeze(['EMAIL_OVERVIEW', 'DEMO', 'WEBSITE', 'CASE_STUDY', 'PRICING', 'OTHER']);
export const MAIN_PRIORITIES = Object.freeze(['VALUATIONS', 'INSTRUCTIONS', 'STOCK', 'BUYER_BUSINESS', 'LEAD_GENERATION', 'DATABASE_UTILISATION', 'OTHER']);
export const MAIN_CONSTRAINTS = Object.freeze([
  'INSUFFICIENT_DEMAND', 'POOR_INCONSISTENT_FOLLOW_UP', 'TEAM_CAPACITY', 'DATABASE_NOT_WORKED',
  'SELLER_OPPORTUNITIES_NOT_IDENTIFIED', 'LOW_VALUATION_CONVERSION', 'UNCLEAR', 'OTHER',
]);

// PITCHED IS DERIVED. The operator never selects it: the outcome says whether
// a pitch could have happened. CALLBACK_REQUESTED only counts when the
// conversation was with the decision-maker (asked as a conditional question);
// NOT_THE_DECISION_MAKER defaults to not pitched unless the operator says a
// proper pitch took place.
export function derivePitched(outcome, { owner_reached: ownerReached = true, pitched_override: pitchedOverride = null } = {}) {
  switch (upper(outcome)) {
    case 'MORE_INFO_REQUESTED':
    case 'NOT_INTERESTED':
    case 'BOOKED_MEETING':
      return true;
    case 'CALLBACK_REQUESTED':
      return ownerReached !== false;
    case 'NOT_THE_DECISION_MAKER':
      return pitchedOverride === true;
    case 'DO_NOT_CALL':
      return pitchedOverride === true;
    default:
      return false;
  }
}

// Someone answered the phone. A wrong number is still a connection; only
// NO_ANSWER is not.
export function deriveConnected(outcome) {
  return upper(outcome) !== 'NO_ANSWER';
}

// The decision-maker was on the line. Gatekept / owner unavailable / wrong
// number / not-the-DM are, by definition, someone else.
export function deriveOwnerReached(outcome, { owner_reached: ownerReached = null } = {}) {
  switch (upper(outcome)) {
    case 'MORE_INFO_REQUESTED':
    case 'NOT_INTERESTED':
    case 'BOOKED_MEETING':
      return true;
    case 'CALLBACK_REQUESTED':
    case 'DO_NOT_CALL':
      return ownerReached !== false;
    default:
      return false;
  }
}

// The commercial-knowledge screen is only worth showing after a real
// conversation with the decision-maker.
export function meaningfulConversation(outcome, opts = {}) {
  return deriveOwnerReached(outcome, opts);
}

// ── scheduling defaults ────────────────────────────────────────────────────
// AUTOMATIC TIMES ARE LONDON WALL-CLOCK TIMES. "Retry tomorrow at 09:00"
// means 09:00 in the UK on that date whether the clocks are on BST or GMT;
// lib/london-time.mjs does the arithmetic and returns the UTC instant that
// is stored. The operator's own picks arrive from the browser as explicit
// instants and are stored as given.
export const CALLING_POLICY = Object.freeze({
  noAnswerRetryDays: 1,
  gatekeptRetryDays: 14,
  moreInfoFollowupWorkingDays: 2,
  defaultHourLondon: 9,
});

export function nextWorkingDayMs(fromMs, hour = CALLING_POLICY.defaultHourLondon) {
  return nextLondonWorkingDay(fromMs, { hour });
}

export function addWorkingDaysMs(fromMs, days, hour = CALLING_POLICY.defaultHourLondon) {
  return addLondonWorkingDays(fromMs, days, { hour });
}

export function addCalendarDaysMs(fromMs, days, hour = CALLING_POLICY.defaultHourLondon) {
  return addLondonCalendarDays(fromMs, days, { hour });
}

// ── validation of the conditional inputs ──────────────────────────────────
// Returns { valid, errors, normalised } where normalised carries the fields
// the CALLS row will store for this outcome. Fields that do not belong to the
// outcome are blanked so a stale value from a previous screen never persists.
export function normaliseOutcomeInput(input, nowMs = Date.now()) {
  const outcome = upper(input?.outcome);
  const errors = [];
  if (!CALL_OUTCOMES.includes(outcome)) errors.push('outcome is required');
  const out = {
    outcome, callback_at: '', callback_note: '', not_interested_reason: '', not_interested_detail: '',
    more_info_type: '', more_info_note: '', meeting_at: '', meeting_note: '', referred_contact: null,
    owner_reached: null, pitched_override: null, followup_at: '',
  };
  const futureIso = (value, label, { required = false } = {}) => {
    const ms = at(value);
    if (ms === null) { if (required) errors.push(`${label} is required`); return ''; }
    if (ms <= nowMs - 60_000) errors.push(`${label} must be in the future`);
    return new Date(ms).toISOString();
  };
  switch (outcome) {
    case 'OWNER_UNAVAILABLE':
      out.callback_at = futureIso(input?.callback_at, 'callback date', { required: true });
      out.callback_note = text(input?.callback_note).slice(0, 500);
      break;
    case 'CALLBACK_REQUESTED':
      out.callback_at = futureIso(input?.callback_at, 'callback date', { required: true });
      out.callback_note = text(input?.callback_note).slice(0, 500);
      out.owner_reached = input?.owner_reached !== false && upper(input?.owner_reached) !== 'FALSE';
      break;
    case 'MORE_INFO_REQUESTED':
      out.more_info_type = upper(input?.more_info_type);
      if (!MORE_INFO_TYPES.includes(out.more_info_type)) errors.push('what they asked for is required');
      out.more_info_note = text(input?.more_info_note).slice(0, 500);
      out.followup_at = futureIso(input?.followup_at || input?.callback_at, 'follow-up date')
        || new Date(addWorkingDaysMs(nowMs, CALLING_POLICY.moreInfoFollowupWorkingDays)).toISOString();
      // Stored on the CALLS row as callback_at so the follow-up can be
      // re-derived from the row alone (see applyCallFollowups).
      out.callback_at = out.followup_at;
      break;
    case 'NOT_INTERESTED':
      out.not_interested_reason = upper(input?.not_interested_reason);
      if (!NOT_INTERESTED_REASONS.includes(out.not_interested_reason)) errors.push('a reason for not interested is required');
      out.not_interested_detail = text(input?.not_interested_detail).slice(0, 500);
      break;
    case 'BOOKED_MEETING':
      out.meeting_at = futureIso(input?.meeting_at, 'meeting date/time', { required: true });
      out.meeting_note = text(input?.meeting_note).slice(0, 500);
      break;
    case 'NOT_THE_DECISION_MAKER': {
      const ref = input?.referred_contact || {};
      out.referred_contact = {
        name: text(ref.name).slice(0, 120), role: text(ref.role).slice(0, 120),
        phone: text(ref.phone).slice(0, 40), email: text(ref.email).slice(0, 160), notes: text(ref.notes).slice(0, 500),
      };
      out.pitched_override = input?.pitched_override === true;
      out.callback_at = futureIso(input?.callback_at, 'callback date');
      break;
    }
    case 'DO_NOT_CALL':
      out.owner_reached = input?.owner_reached !== false && upper(input?.owner_reached) !== 'FALSE';
      out.pitched_override = input?.pitched_override === true;
      break;
    default:
      break;
  }
  return { valid: errors.length === 0, errors, normalised: out };
}

// Rebuilds the plan inputs from a STORED CALLS row, so the follow-ups of an
// already-saved call can be (re)applied without the original request —
// the recovery path when an ACTIONS write failed after the row landed.
export function normalisedFromRow(row) {
  let meta = {};
  try { meta = JSON.parse(text(row?.metadata_json) || '{}'); } catch { meta = {}; }
  let referred = null;
  try { referred = text(row?.referred_contact_json) ? JSON.parse(row.referred_contact_json) : null; } catch { referred = null; }
  return {
    outcome: upper(row?.outcome), callback_at: text(row?.callback_at), callback_note: text(row?.callback_note),
    not_interested_reason: text(row?.not_interested_reason), not_interested_detail: text(row?.not_interested_detail),
    more_info_type: text(row?.more_info_type), more_info_note: text(row?.more_info_note),
    meeting_at: text(row?.meeting_at), meeting_note: text(row?.meeting_note), referred_contact: referred,
    owner_reached: meta.owner_reached_input ?? null, pitched_override: meta.pitched_override ?? null,
    followup_at: upper(row?.outcome) === 'MORE_INFO_REQUESTED' ? text(row?.callback_at) : '',
  };
}

// ── the follow-up plan ─────────────────────────────────────────────────────
// What one saved call does to the rest of NOVUS. `call_actions` go in the
// ACTIONS ledger flagged as calling work (the Call Actions tab); `actions` are
// ordinary manual sales actions for the generic Actions queue. Both carry
// manual:true so the lifecycle reconciler never cancels them, and every
// dedupe_key includes the call id so two saves of one call cannot duplicate.
export function planOutcome(call, normalised, { nowMs = Date.now() } = {}) {
  const outcome = upper(normalised.outcome);
  const agencyId = text(call.agency_id);
  const callId = text(call.call_id);
  const nowIso = new Date(nowMs).toISOString();
  const contact = text(call.contact_name) || 'the contact';
  const base = (type, dueAt, reason, extra = {}) => ({
    agency_id: agencyId, outreach_id: text(call.outreach_id), probe_id: text(call.probe_id),
    action_type: type, action_owner: 'JOE', action_status: at(dueAt) !== null && at(dueAt) <= nowMs ? 'DUE' : 'PENDING',
    due_at: dueAt, reason, source_stage: 'CALLING',
    dedupe_key: `${agencyId}:${type}:call:${callId}`,
    metadata_json: JSON.stringify({ manual: true, call_id: callId, outcome, ...extra }),
  });
  const callAction = (type, dueAt, reason, extra = {}) => base(type, dueAt, reason, {
    call_action: true, previous_outcome: outcome, attempt_number: Number(call.attempt_number) || 1, ...extra,
  });

  const plan = { call_actions: [], actions: [], terminal: null, suppress_calling: false, wrong_number: false };
  switch (outcome) {
    case 'NO_ANSWER':
      plan.call_actions.push(callAction('RETRY_CALL', new Date(addCalendarDaysMs(nowMs, CALLING_POLICY.noAnswerRetryDays)).toISOString(),
        'No answer; retry the following day', { callback_reason: 'No answer retry' }));
      break;
    case 'GATEKEPT':
      plan.call_actions.push(callAction('RETRY_CALL', new Date(addCalendarDaysMs(nowMs, CALLING_POLICY.gatekeptRetryDays)).toISOString(),
        'Gatekept; retry in 14 days', { callback_reason: 'Gatekept' }));
      break;
    case 'OWNER_UNAVAILABLE':
      plan.call_actions.push(callAction('CALL_PROSPECT', normalised.callback_at,
        normalised.callback_note ? `Owner unavailable: ${normalised.callback_note}` : 'Owner unavailable; call back when in',
        { callback_reason: 'Owner unavailable', callback_note: normalised.callback_note }));
      break;
    case 'CALLBACK_REQUESTED':
      plan.call_actions.push(callAction('CALL_PROSPECT', normalised.callback_at,
        normalised.callback_note ? `Callback requested: ${normalised.callback_note}` : `${contact} asked for a callback`,
        { callback_reason: 'Callback requested', callback_note: normalised.callback_note }));
      break;
    case 'MORE_INFO_REQUESTED':
      plan.actions.push(base('SEND_INFORMATION', nowIso,
        `Send ${normalised.more_info_type.toLowerCase().replace(/_/g, ' ')} requested on the call${normalised.more_info_note ? `: ${normalised.more_info_note}` : ''}`,
        { more_info_type: normalised.more_info_type, note: normalised.more_info_note, title: 'Send requested information' }));
      plan.call_actions.push(callAction('CALL_PROSPECT', normalised.followup_at || normalised.callback_at,
        `Follow up after sending ${normalised.more_info_type.toLowerCase().replace(/_/g, ' ')}`,
        { callback_reason: 'Information follow-up', more_info_type: normalised.more_info_type }));
      break;
    case 'NOT_INTERESTED':
      plan.terminal = 'NOT_INTERESTED';
      plan.suppress_calling = true;
      break;
    case 'BOOKED_MEETING':
      plan.terminal = 'MEETING_BOOKED';
      plan.suppress_calling = true;
      plan.actions.push(base('PREPARE_MEETING', new Date(Math.max(nowMs, (at(normalised.meeting_at) ?? nowMs) - 24 * 60 * 60 * 1000)).toISOString(),
        `Prepare for the meeting booked on the call${normalised.meeting_note ? `: ${normalised.meeting_note}` : ''}`,
        { meeting_at: normalised.meeting_at, note: normalised.meeting_note, title: 'Prepare for meeting' }));
      break;
    case 'WRONG_NUMBER':
      plan.wrong_number = true;
      break;
    case 'NOT_THE_DECISION_MAKER': {
      const ref = normalised.referred_contact || {};
      if (ref.phone || ref.name) {
        const dueAt = normalised.callback_at || new Date(nextWorkingDayMs(nowMs)).toISOString();
        plan.call_actions.push(callAction('CALL_PROSPECT', dueAt,
          `Call ${ref.name || 'the decision-maker'}${ref.role ? ` (${ref.role})` : ''} instead${ref.phone ? ` on ${ref.phone}` : ''}`,
          { callback_reason: 'Referred to decision-maker', contact_override: ref }));
      }
      break;
    }
    case 'DO_NOT_CALL':
      plan.suppress_calling = true;
      break;
    default:
      break;
  }
  return plan;
}

