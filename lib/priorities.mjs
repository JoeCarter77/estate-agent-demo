// lib/priorities.mjs — YOUR PRIORITIES. Pure; no I/O.
//
// One ranked, plain-English list of what Joe and Louis should do next, built
// from the EXISTING durable ACTIONS ledger plus a handful of derived checks
// for opportunities that have fallen through a gap. Nothing here writes, and
// nothing here is a second action store: an exception card disappears the
// moment the record that is missing exists.
//
// THREE RULES THE WORDING FOLLOWS
//   1. Every headline comes from the real situation (who asked for what, when),
//      never from the action type alone. A CALL_PROSPECT is not urgent because
//      it is a CALL_PROSPECT.
//   2. Recorded facts and NOVUS's suggestion are kept apart: `facts` only ever
//      holds what a CALLS / REPLY_EVENTS / ACTIONS / DISCOVERY_SESSIONS row
//      says; `next_step` is labelled as a suggestion by the page.
//   3. Unknown stays unknown — a missing contact name is '' and the page says
//      "not recorded", it is never guessed.
//
// PRIORITY is a deterministic points score (`score_reasons` explains every
// point) — commitment made to the prospect, expressed interest, seniority,
// time sensitivity, overdue promises, meetings. Tiers:
//   FIRST     due now and score >= FIRST_SCORE (capped at FIRST_LIMIT)
//   TODAY     everything else due today or overdue — overdue never disappears
//   COMING_UP due after today (London calendar)

import { actionQueue, isCallingWorkflowAction } from './acquisition-actions.mjs';
import { decisionMakerTier } from './calling-queue.mjs';
import { londonDayNumber } from './london-time.mjs';
import { deriveLeadOwners } from './lead-ownership.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => { const ms = Date.parse(text(value)); return Number.isFinite(ms) ? ms : null; };
const DAY_MS = 86_400_000;
const ACTIVE = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);
const TERMINAL_PIPELINE = new Set(['NOT_INTERESTED', 'CLOSED', 'OPTED_OUT', 'EXCLUDED']);
const INTEREST_CLASSES = new Set(['POSITIVE_INTEREST', 'CALL_REQUESTED', 'INFO_REQUESTED', 'MEETING_REQUESTED', 'POSITIVE_SEND_DEMO']);
// Meeting outcomes after which the opportunity is still open and needs a next step.
const OPEN_MEETING_OUTCOMES = new Set(['PILOT_AGREED', 'PROPOSAL_REQUESTED', 'FOLLOW_UP_REQUIRED', 'TECHNICAL_ASSESSMENT_REQUIRED', 'FURTHER_DISCOVERY_REQUIRED']);
const MEETING_GRACE_MS = 2 * 60 * 60 * 1000; // a meeting is "over" two hours after it started
const IN_PROGRESS_WINDOW_MS = 30 * 60 * 1000;

export const FIRST_SCORE = 55;
export const FIRST_LIMIT = 6;
export const PRIORITY_TABS = Object.freeze(['ACTIONS', 'AGENCIES', 'CONTACTS', 'CALLS', 'REPLY_EVENTS', 'DISCOVERY_SESSIONS', 'LEAD_OWNERSHIP', 'SALES_MESSAGES']);

export const MORE_INFO_WORDS = Object.freeze({
  EMAIL_OVERVIEW: 'an email overview', DEMO: 'a demo', WEBSITE: 'the website link', CASE_STUDY: 'a case study', PRICING: 'pricing', OTHER: 'more information',
});
const OUTCOME_WORDS = Object.freeze({
  NO_ANSWER: 'No answer', GATEKEPT: 'Gatekeeper — did not get through', OWNER_UNAVAILABLE: 'Owner not available',
  CALLBACK_REQUESTED: 'Asked for a callback', MORE_INFO_REQUESTED: 'Asked for more information', NOT_INTERESTED: 'Not interested',
  BOOKED_MEETING: 'Meeting booked', WRONG_NUMBER: 'Wrong number', NOT_THE_DECISION_MAKER: 'Not the decision-maker',
  DO_NOT_CALL: 'Asked not to be called', REFERRED_TO_EMAIL: 'Referred us to email',
});
const MEETING_OUTCOME_WORDS = Object.freeze({
  PILOT_AGREED: 'Pilot agreed', PROPOSAL_REQUESTED: 'Proposal requested', FOLLOW_UP_REQUIRED: 'Follow-up required',
  TECHNICAL_ASSESSMENT_REQUIRED: 'Technical assessment required', FURTHER_DISCOVERY_REQUIRED: 'Further discovery required',
  NOT_SUITABLE: 'Not suitable', NOT_INTERESTED: 'Not interested',
});
const REPLY_WORDS = Object.freeze({
  POSITIVE_INTEREST: 'Interested', CALL_REQUESTED: 'Asked for a call', INFO_REQUESTED: 'Asked for information', QUESTION: 'Asked a question',
  NOT_NOW: 'Not right now', NOT_INTERESTED: 'Not interested', OPT_OUT: 'Opted out', OTHER_UNCLEAR: 'Unclear', OOO_AUTOMATED: 'Out of office',
  MEETING_REQUESTED: 'Asked for a meeting', POSITIVE_SEND_DEMO: 'Asked for the demo',
});

// ── table helpers ───────────────────────────────────────────────────────────
export function tableRows(table) {
  const header = table?.header || [];
  if (!header.length) return [];
  const first = header[0];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[0]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))];
  }).filter((obj) => text(obj[first]));
}
const meta = (row) => { try { return JSON.parse(text(row?.metadata_json) || '{}') || {}; } catch { return {}; } };
function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = text(row[key]);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}
const newestFirst = (field) => (a, b) => (ts(b[field]) ?? 0) - (ts(a[field]) ?? 0);
const short = (value, n = 220) => { const s = text(value).replace(/\s+/g, ' '); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const isTestAgency = (name) => /^\s*test\b/i.test(text(name));

// ── London calendar ─────────────────────────────────────────────────────────
function dueBucket(dueMs, nowMs) {
  if (dueMs === null) return { day: 'none', overdue: false, overdue_days: 0, due_now: true };
  const today = londonDayNumber(nowMs);
  const day = londonDayNumber(dueMs);
  if (day < today) return { day: 'overdue', overdue: true, overdue_days: today - day, due_now: true };
  if (day === today) return { day: 'today', overdue: false, overdue_days: 0, due_now: true };
  return { day: day === today + 1 ? 'tomorrow' : 'later', overdue: false, overdue_days: 0, due_now: false };
}
function londonDayName(ms, nowMs) {
  const diff = londonDayNumber(ms) - londonDayNumber(nowMs);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long' }).format(new Date(ms));
  if (Math.abs(diff) < 7) return weekday;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

// ── per-agency context ──────────────────────────────────────────────────────
function agencyName(agency) { return text(agency?.clean_agency_name || agency?.agency_name) || 'Unnamed agency'; }

function bestContact({ agency, contacts, action, call }) {
  const m = meta(action);
  const override = m.contact_override || m.referred_contact;
  const candidates = [];
  if (override && (text(override.name) || text(override.phone))) candidates.push({ name: text(override.name), role: text(override.role), phone: text(override.phone), email: text(override.email), source: 'referred on a call' });
  if (text(m.contact_name)) candidates.push({ name: text(m.contact_name), role: '', phone: text(m.phone?.raw), email: '', source: 'reply' });
  if (call && text(call.contact_name)) candidates.push({ name: text(call.contact_name), role: text(call.contact_role), phone: text(call.phone), email: '', source: 'last call' });
  const ranked = [...(contacts || [])].sort((a, b) => {
    const tier = (c) => ({ NAMED_OWNER: 0, NAMED_SENIOR_DECISION_MAKER: 1, NAMED_CONTACT: 2, UNNAMED: 3 })[decisionMakerTier({ contactName: c.contact_name, contactRole: c.contact_role, agency }).tier];
    return tier(a) - tier(b);
  });
  for (const c of ranked) candidates.push({ name: text(c.contact_name), role: text(c.contact_role), phone: text(c.phone || c.mobile), email: text(c.email), source: 'contacts' });
  if (text(agency?.outreach_contact_name)) candidates.push({ name: text(agency.outreach_contact_name), role: '', phone: '', email: text(agency.outreach_contact_email), source: 'agency record' });
  const chosen = candidates.find((c) => c.name) || candidates[0] || { name: '', role: '', phone: '', email: '', source: '' };
  // Fill gaps from the same person elsewhere, then the agency's main line.
  const same = candidates.filter((c) => c.name && c.name.toLowerCase() === chosen.name.toLowerCase());
  const role = chosen.role || same.map((c) => c.role).find(Boolean) || '';
  const phone = chosen.phone || same.map((c) => c.phone).find(Boolean) || text(agency?.main_phone);
  const email = chosen.email || same.map((c) => c.email).find(Boolean) || text(agency?.outreach_contact_email);
  const tier = decisionMakerTier({ contactName: chosen.name, contactRole: role, agency }).tier;
  return { name: chosen.name, role, phone, email, decision_maker: tier === 'NAMED_OWNER' || tier === 'NAMED_SENIOR_DECISION_MAKER', tier };
}

function lastTouch({ calls, sales, replies }) {
  const events = [
    ...calls.filter((c) => text(c.outcome)).map((c) => ({ at: text(c.started_at), by: text(meta(c).user_id) || 'admin', channel: 'call', summary: OUTCOME_WORDS[upper(c.outcome)] || text(c.outcome) })),
    ...sales.filter((s) => upper(s.send_outcome) === 'SENT').map((s) => ({ at: text(s.sent_at || s.created_at), by: text(s.sent_by) || 'admin', channel: 'email', summary: 'We emailed them' })),
    ...replies.map((r) => ({ at: text(r.received_at), by: '', channel: 'their reply', summary: REPLY_WORDS[upper(r.classification)] || 'They replied' })),
  ].filter((e) => ts(e.at) !== null).sort((a, b) => ts(b.at) - ts(a.at));
  return { last: events[0] || null, recent: events.slice(0, 5) };
}

function meetingFor({ calls, sessions, actions }) {
  const booked = calls.filter((c) => upper(c.outcome) === 'BOOKED_MEETING' && ts(c.meeting_at) !== null).sort(newestFirst('meeting_at'))[0] || null;
  const session = [...sessions].sort((a, b) => (ts(b.meeting_at || b.created_at) ?? 0) - (ts(a.meeting_at || a.created_at) ?? 0))[0] || null;
  const prep = actions.find((a) => upper(a.action_type) === 'PREPARE_MEETING' && ts(meta(a).meeting_at) !== null);
  const at = text(booked?.meeting_at) || text(session?.meeting_at) || text(meta(prep).meeting_at);
  if (!at && !session) return null;
  return {
    at, note: text(booked?.meeting_note) || text(meta(prep).note), booked_by: text(meta(booked).user_id), call_id: text(booked?.call_id),
    session_id: text(session?.session_id), session_status: upper(session?.status), outcome: upper(session?.outcome),
    outcome_label: MEETING_OUTCOME_WORDS[upper(session?.outcome)] || '', follow_up_at: text(session?.follow_up_at), outcome_notes: short(session?.outcome_notes, 400),
    completed_at: text(session?.completed_at),
  };
}

// ── the situation → words + points table ────────────────────────────────────
// Each branch returns { key, base, commitment, headline(dueDay), summary, next_step, primary }.
// `commitment` = we (or they) made a promise with a time attached, so being
// late on it is worse than being late on routine work.
function situationFor(action, ctx) {
  const type = upper(action.action_type);
  const m = meta(action);
  const { contact, call, reply, meeting, nowMs } = ctx;
  const who = contact.name ? contact.name.split(/\s+/)[0] : 'them';
  const whoFull = contact.name ? `${contact.name}${contact.role ? ` (${contact.role})` : ''}` : 'the contact';
  const lastCallDay = call ? londonDayName(ts(call.started_at) ?? nowMs, nowMs) : '';
  const callNote = text(call?.callback_note || m.callback_note || call?.useful_note);

  if (['CALL_PROSPECT', 'RETRY_CALL', 'CALL'].includes(type)) {
    const primary = { kind: 'call', label: `Call ${contact.name ? who : 'now'}` };
    if (m.source === 'EMAIL_REPLY') {
      return {
        key: 'CALL_REQUESTED_BY_EMAIL', base: 70, commitment: true, primary,
        headline: (d) => m.needs_review ? 'CALL REQUESTED — CHECK THE NUMBER FIRST' : d === 'overdue' ? 'OVERDUE — THEY ASKED US TO CALL' : d === 'today' || d === 'none' ? 'THEY ASKED FOR A CALL — RING TODAY' : `CALL REQUESTED — ${d.toUpperCase()}`,
        summary: `${contact.name || 'The prospect'} replied by email asking for a call${m.timing?.language ? ` (${short(m.timing.language, 60)})` : ''}.`,
        next_step: `Call ${whoFull}, refer to their email and aim to book a discovery meeting.`,
      };
    }
    const reason = text(m.callback_reason);
    if (reason === 'Callback requested') {
      const dm = upper(call?.owner_reached) === 'TRUE' || contact.decision_maker;
      return {
        key: 'REQUESTED_CALLBACK', base: dm ? 62 : 52, commitment: true, primary,
        headline: (d) => d === 'overdue' ? 'OVERDUE CALLBACK — THEY ASKED US TO CALL' : (d === 'today' || d === 'none') ? (dm ? 'HUGE PRIORITY TODAY — NEEDS A CALLBACK' : 'CALLBACK DUE TODAY') : `CALLBACK BOOKED — ${d.toUpperCase()}`,
        summary: `${contact.name || 'They'}${dm && contact.role ? `, ${contact.role},` : ''} asked to be called back${lastCallDay ? ` when we spoke ${lastCallDay}` : ''}.${callNote ? ` “${short(callNote, 120)}”` : ''}`,
        next_step: `Call ${whoFull}, refer to ${lastCallDay ? `${lastCallDay}'s` : 'the last'} conversation and aim to book a discovery meeting.`,
      };
    }
    if (reason === 'Owner unavailable') return {
      key: 'OWNER_UNAVAILABLE', base: 32, commitment: false, primary,
      headline: (d) => d === 'later' || d === 'tomorrow' ? `CALL BACK ${d.toUpperCase()} — OWNER WAS OUT` : 'CALL BACK — THE OWNER WAS OUT LAST TIME',
      summary: `The decision-maker wasn't available${lastCallDay ? ` ${lastCallDay}` : ''}.${callNote ? ` “${short(callNote, 120)}”` : ''}`,
      next_step: `Ask for ${contact.name || 'the owner'} by name; if they're out again, get a time they'll be in.`,
    };
    if (reason === 'Referred to decision-maker') {
      const ref = m.contact_override || {};
      return {
        key: 'CALL_DECISION_MAKER', base: 45, commitment: false, primary,
        headline: () => `CALL THE DECISION-MAKER${text(ref.name) ? ` — ${upper(ref.name)}` : ''}`,
        summary: `We were referred to ${text(ref.name) || 'the decision-maker'}${text(ref.role) ? ` (${text(ref.role)})` : ''}${lastCallDay ? ` ${lastCallDay}` : ''}.`,
        next_step: `Call ${text(ref.name) || 'the decision-maker'}${text(ref.phone) ? ` on ${text(ref.phone)}` : ''} and mention who referred you.`,
      };
    }
    if (reason === 'Information follow-up') {
      const what = MORE_INFO_WORDS[upper(m.more_info_type)] || 'the information';
      return {
        key: 'INFO_FOLLOW_UP_CALL', base: 45, commitment: true, primary,
        headline: () => `FOLLOW UP ${upper(what).replace(/^(AN?|THE) /, 'THE ')} WE SENT`,
        summary: `They asked for ${what}${lastCallDay ? ` ${lastCallDay}` : ''}; this call checks they got it.`,
        next_step: `Call ${whoFull}: did ${what} land, any questions, and can we book a discovery meeting?`,
      };
    }
    if (type === 'RETRY_CALL') {
      const gatekept = upper(m.previous_outcome) === 'GATEKEPT' || reason === 'Gatekept';
      return {
        key: gatekept ? 'RETRY_GATEKEPT' : 'RETRY_NO_ANSWER', base: gatekept ? 20 : 15, commitment: false, primary,
        headline: () => gatekept ? 'TRY AGAIN — GATEKEEPER LAST TIME' : 'TRY AGAIN — NO ANSWER LAST TIME',
        summary: `${gatekept ? 'We were stopped by a gatekeeper' : 'Nobody answered'}${lastCallDay ? ` ${lastCallDay}` : ''}. Attempt ${(Number(m.attempt_number) || 1) + 1}.`,
        next_step: gatekept ? `Ask for ${contact.name || 'the owner'} by name and keep it brief.` : `Try ${contact.phone ? contact.phone : 'the main line'} again.`,
      };
    }
    if (/demo engagement/i.test(text(action.reason))) return {
      key: 'DEMO_ENGAGED', base: 50, commitment: false, primary,
      headline: () => 'THEY ENGAGED WITH THE DEMO — CALL THEM',
      summary: 'They clicked through or came back to their personalised demo.',
      next_step: `Call ${whoFull} while it's fresh and offer a discovery meeting.`,
    };
    if (/follow-up received no newer inbound reply/i.test(text(action.reason))) return {
      key: 'DEMO_FOLLOWUP_NO_REPLY', base: 30, commitment: false, primary,
      headline: () => 'NO REPLY TO THE DEMO FOLLOW-UP — CALL THEM',
      summary: 'We followed up on the demo by email and heard nothing back.',
      next_step: `Call ${whoFull} and ask what they made of the demo.`,
    };
    return {
      key: 'CALL', base: manualPriority(m, 25), commitment: false, primary,
      headline: () => text(m.title) ? upper(m.title) : 'CALL THIS AGENCY',
      summary: short(m.note || action.reason) || 'A call is scheduled.',
      next_step: `Call ${whoFull}.`,
    };
  }

  const replyPrimary = { kind: 'reply', label: 'Open & reply' };
  const replyText = short(m.reply_text || reply?.cleaned_reply_text || reply?.body_text, 200);
  switch (type) {
    case 'HUMAN_REPLY':
    case 'REPLY': {
      if (m.interested) return {
        key: 'INTERESTED_REPLY', base: 65, commitment: true, primary: replyPrimary,
        headline: (d) => d === 'overdue' ? 'INTERESTED REPLY — STILL UNANSWERED' : 'INTERESTED REPLY — RESPOND TODAY',
        summary: replyText ? `“${replyText}”` : `${contact.name || 'They'} replied with interest.`,
        next_step: 'Reply today and offer two times for a short discovery call.',
      };
      const question = upper(reply?.classification) === 'QUESTION';
      return {
        key: question ? 'QUESTION_REPLY' : 'REPLY_NEEDED', base: question ? 50 : 40, commitment: true, primary: replyPrimary,
        headline: (d) => d === 'overdue' ? (question ? 'THEY ASKED A QUESTION — STILL UNANSWERED' : 'REPLY STILL OUTSTANDING') : (question ? 'THEY ASKED A QUESTION — REPLY' : 'REPLY NEEDED'),
        summary: replyText ? `“${replyText}”` : short(action.reason),
        next_step: 'Answer their question directly, then suggest a short call.',
      };
    }
    case 'SEND_INFORMATION': {
      const what = MORE_INFO_WORDS[upper(m.more_info_type)] || 'information';
      return {
        key: 'SEND_INFORMATION', base: 55, commitment: true, primary: { kind: 'reply', label: 'Send it' },
        headline: (d) => d === 'overdue' ? `PROMISED ${upper(what)} — NOT SENT YET` : `THEY ASKED FOR ${upper(what)} — SEND IT TODAY`,
        summary: `${contact.name || 'They'} asked for ${what}${call ? ` on the call ${lastCallDay}` : ''}.${text(m.note) ? ` “${short(m.note, 120)}”` : ''}`,
        next_step: `Send ${what} to ${contact.email || 'their email'}; a follow-up call is already scheduled.`,
      };
    }
    case 'MANUAL_REVIEW': return {
      key: 'UNCLEAR_REPLY', base: 40, commitment: false, primary: { kind: 'reply', label: 'Read the reply' },
      headline: () => 'CHECK THIS REPLY — NEEDS YOUR DECISION',
      summary: replyText ? `“${replyText}”` : 'NOVUS could not classify this reply with confidence.',
      next_step: 'Read it and decide: reply, call, or close the lead.',
    };
    case 'SET_NEXT_STEP': return {
      key: 'NOT_NOW', base: 30, commitment: false, primary: replyPrimary,
      headline: () => 'NOT RIGHT NOW — AGREE WHEN TO COME BACK',
      summary: replyText ? `“${replyText}”` : 'They said not right now.',
      next_step: 'Thank them and agree a specific month to get back in touch.',
    };
    case 'FOLLOW_UP': {
      if (m.no_show) return {
        key: 'NO_SHOW_REBOOK', base: 60, commitment: true, primary: { kind: 'call', label: 'Call to rebook' },
        headline: () => 'MISSED MEETING — REBOOK IT',
        summary: `The meeting${ts(m.meeting_at) !== null ? ` ${londonDayName(ts(m.meeting_at), nowMs)}` : ''} didn't happen.`,
        next_step: `Call ${whoFull}, keep it light, and offer two new times.`,
      };
      if (m.referred_contact && upper(m.channel) === 'EMAIL') return {
        key: 'EMAIL_REFERRED_CONTACT', base: 35, commitment: false, primary: replyPrimary,
        headline: () => 'EMAIL THE CONTACT THE GATEKEEPER GAVE US',
        summary: `On the phone we were told to email ${text(m.referred_contact.name) || 'them'}${text(m.referred_contact.email) ? ` at ${text(m.referred_contact.email)}` : ''}.`,
        next_step: 'Send a short intro email mentioning the call, then call again in two days.',
      };
      if (/out-of-office/i.test(text(action.reason))) return {
        key: 'OOO_RETURN', base: 25, commitment: false, primary: replyPrimary,
        headline: (d) => d === 'later' || d === 'tomorrow' ? `OUT OF OFFICE — FOLLOW UP ${d.toUpperCase()}` : 'BACK FROM LEAVE — FOLLOW UP',
        summary: 'Their auto-reply said they were away; the email sequence stopped on it.',
        next_step: 'Send a short personal follow-up now they are back.',
      };
      return {
        key: 'FOLLOW_UP', base: manualPriority(m, 25), commitment: false, primary: replyPrimary,
        headline: () => text(m.title) ? upper(m.title) : 'FOLLOW UP',
        summary: short(m.note || action.reason) || 'A follow-up is due.',
        next_step: short(m.note) || 'Follow up and propose a next step.',
      };
    }
    case 'FOLLOW_UP_CONVERSATION': return {
      key: 'NO_ANSWER_TO_OUR_REPLY', base: 25, commitment: false, primary: replyPrimary,
      headline: () => 'NO ANSWER TO OUR REPLY — FOLLOW UP',
      summary: 'We replied to them and have not heard back.',
      next_step: 'Send a one-line nudge or call them.',
    };
    case 'DEMO_UNOPENED_FOLLOWUP': return {
      key: 'DEMO_UNOPENED', base: 25, commitment: false, primary: replyPrimary,
      headline: () => 'DEMO NOT OPENED — NUDGE THEM', summary: 'We sent their demo and it has not been opened.',
      next_step: 'Send a short nudge with the link.',
    };
    case 'DEMO_OPENED_FOLLOWUP': return {
      key: 'DEMO_OPENED', base: 40, commitment: false, primary: replyPrimary,
      headline: () => 'THEY OPENED THE DEMO — FOLLOW UP', summary: 'They opened their personalised demo.',
      next_step: 'Ask what stood out and offer a discovery call.',
    };
    case 'PREPARE_MEETING': return meetingSituation(action, ctx);
    case 'MEETING_FOLLOW_UP': {
      const outcome = upper(m.outcome || meeting?.outcome);
      const notes = meeting?.outcome_notes ? ` Notes: “${short(meeting.outcome_notes, 140)}”` : '';
      const map = {
        PILOT_AGREED: ['PILOT_AGREED', 85, 'PILOT AGREED — START ONBOARDING', 'Send the pilot agreement and invoice, then book the kick-off.'],
        PROPOSAL_REQUESTED: ['PROPOSAL_REQUESTED', 70, 'PROPOSAL REQUESTED — SEND AND FOLLOW UP', 'Send the founding pilot proposal and agree a decision date.'],
        TECHNICAL_ASSESSMENT_REQUIRED: ['TECH_CHECK', 55, 'TECHNICAL CHECK NEEDED BEFORE THEY DECIDE', 'Confirm CRM access and data, then return to the decision.'],
        FURTHER_DISCOVERY_REQUIRED: ['SECOND_MEETING', 50, 'BOOK THE SECOND CONVERSATION', 'Book the follow-up discovery session.'],
      };
      const [key, base, headline, next] = map[outcome] || ['MEETING_FOLLOW_UP', 60, 'MEETING FINISHED — SEND FOLLOW-UP', 'Send the meeting follow-up and agree the next step.'];
      return {
        key, base, commitment: true, primary: { kind: 'meeting', label: 'Open meeting' },
        headline: () => headline,
        summary: `Meeting outcome: ${MEETING_OUTCOME_WORDS[outcome] || 'recorded'}.${notes}`,
        next_step: next,
      };
    }
    case 'HANDOFF_TO_INSTANTLY': return {
      key: 'HANDOFF', base: 8, commitment: false, primary: { kind: 'profile', label: 'Open lead' },
      headline: () => 'READY FOR THE EMAIL CAMPAIGN', summary: 'Probe complete and outreach prepared.',
      next_step: 'Add to the next campaign from Email › Campaigns.',
    };
    case 'RESOLVE_EXCEPTION': return {
      key: 'RESOLVE_EXCEPTION', base: 30, commitment: false, primary: { kind: 'profile', label: 'Open lead' },
      headline: () => 'SOMETHING IS STUCK — CHECK IT', summary: short(action.reason) || 'The pipeline reported an error.',
      next_step: 'Open the lead and fix the record.',
    };
    default: return {
      key: 'MANUAL', base: manualPriority(m, 25), commitment: false, primary: { kind: 'profile', label: 'Open lead' },
      headline: () => text(m.title) ? upper(m.title) : upper(type.replace(/_/g, ' ')),
      summary: short(m.note || action.reason) || 'Manual task.',
      next_step: short(m.note) || 'Complete the task.',
    };
  }
}
function manualPriority(m, fallback) {
  return { CRITICAL: 70, HIGH: 50, NORMAL: fallback, LOW: 10 }[upper(m.priority)] ?? fallback;
}

function meetingSituation(action, ctx) {
  const { meeting, nowMs, contact } = ctx;
  const m = meta(action);
  const at = ts(m.meeting_at) ?? ts(meeting?.at);
  const primary = { kind: 'meeting', label: 'Open meeting' };
  const handover = m.handover || {};
  const handoverLine = [text(handover.meeting_note || m.note), text(handover.useful_note)].filter(Boolean).join(' · ');
  if (meeting?.outcome) return {
    key: 'PREP_AFTER_OUTCOME', base: 5, commitment: false, primary,
    headline: () => 'MEETING DONE — CLOSE THIS PREP TASK',
    summary: `Outcome already recorded: ${meeting.outcome_label}.`,
    next_step: 'Mark this prep task complete; the meeting follow-up carries on separately.',
  };
  if (at !== null && at + MEETING_GRACE_MS < nowMs) return {
    key: 'MEETING_OUTCOME_MISSING', base: 75, commitment: true, primary,
    headline: () => 'MEETING HAPPENED? RECORD THE OUTCOME',
    summary: `The meeting was ${londonDayName(at, nowMs)} and no outcome has been recorded.`,
    next_step: 'Record what happened. If they did not turn up, use “No-show” so a rebook is scheduled.',
  };
  const day = at === null ? '' : londonDayName(at, nowMs);
  return {
    key: day === 'today' ? 'MEETING_TODAY' : day === 'tomorrow' ? 'MEETING_TOMORROW' : 'MEETING_UPCOMING',
    base: day === 'today' ? 90 : day === 'tomorrow' ? 60 : 35, commitment: true, primary,
    headline: () => at === null ? 'MEETING BOOKED — PREPARE (NO TIME RECORDED)' : day === 'today' ? 'MEETING TODAY — PREPARE NOW' : `MEETING ${upper(day)} — PREPARE`,
    summary: `${contact.name ? `With ${contact.name}${contact.role ? ` (${contact.role})` : ''}. ` : ''}${handoverLine ? `Handover: “${short(handoverLine, 160)}”` : 'No handover notes recorded.'}`,
    next_step: 'Review the probe result and call notes, then open the discovery workspace before the meeting.',
  };
}

// ── scoring ─────────────────────────────────────────────────────────────────
function score(sit, { due, contact, lastMeaningfulAgeDays, interested, test }) {
  const reasons = [[`${sit.key.toLowerCase().replace(/_/g, ' ')}`, sit.base]];
  if (contact.decision_maker && ['call', 'reply'].includes(sit.primary.kind)) reasons.push(['decision-maker', contact.tier === 'NAMED_OWNER' ? 10 : 6]);
  if (due.overdue && sit.commitment) reasons.push([`promise overdue ${due.overdue_days}d`, due.overdue_days >= 3 ? 15 : 10]);
  else if (due.overdue) reasons.push([`overdue ${due.overdue_days}d`, due.overdue_days > 21 ? -5 : 3]);
  if (due.day === 'today') reasons.push(['due today', 5]);
  if (interested && lastMeaningfulAgeDays !== null && lastMeaningfulAgeDays > 7) reasons.push(['interest going cold', 5]);
  if (test) reasons.push(['test record', -60]);
  return { score: reasons.reduce((n, [, p]) => n + p, 0), reasons: reasons.map(([label, points]) => ({ label, points })) };
}

// ── exceptions: active opportunities with no owned next step ───────────────
function exceptionCards(ctxByAgency, { nowMs, unmatchedReplies }) {
  const cards = [];
  for (const ctx of ctxByAgency.values()) {
    const { agency, activeActions, meeting, replies, calls, allActions } = ctx;
    const pipeline = upper(agency.current_pipeline_status);
    if (TERMINAL_PIPELINE.has(pipeline)) continue;
    const activeTypes = new Set(activeActions.map((a) => upper(a.action_type)));
    const base = { ctx };

    // E1 meeting time passed, nothing recorded, nothing scheduled.
    const meetingMs = ts(meeting?.at);
    if (meeting && !meeting.outcome && meetingMs !== null && meetingMs + MEETING_GRACE_MS < nowMs && !activeTypes.has('PREPARE_MEETING')) {
      const noShow = allActions.find((a) => meta(a).no_show && text(meta(a).meeting_at) === text(meeting.at));
      const laterActive = activeActions.some((a) => (ts(a.created_at) ?? 0) > meetingMs);
      if (!laterActive) cards.push({ ...base, key: noShow ? 'NO_SHOW_NOTHING_SCHEDULED' : 'MEETING_OUTCOME_MISSING', base: noShow ? 60 : 75, commitment: true,
        headline: noShow ? 'MISSED MEETING — NOTHING SCHEDULED' : 'MEETING HAPPENED? RECORD THE OUTCOME',
        summary: noShow ? 'They missed the meeting and no rebook is scheduled.' : `The meeting was ${londonDayName(meetingMs, nowMs)} and no outcome has been recorded.`,
        next_step: noShow ? 'Call to rebook, or close the lead if they have gone quiet.' : 'Record what happened. If they did not turn up, use “No-show” so a rebook is scheduled.',
        primary: { kind: 'meeting', label: 'Open meeting' }, due_ms: meetingMs + MEETING_GRACE_MS });
    }
    // E2 booked with no date anywhere.
    if (pipeline === 'MEETING_BOOKED' && !meeting && !activeTypes.has('PREPARE_MEETING')) {
      cards.push({ ...base, key: 'MEETING_NO_DATE', base: 50, commitment: true, headline: 'MEETING BOOKED — NO DATE RECORDED',
        summary: 'The agency is marked “meeting booked” but no meeting time exists anywhere.',
        next_step: 'Confirm the date with them and record it in Meetings.', primary: { kind: 'meeting', label: 'Open meeting' }, due_ms: null });
    }
    // E3 open meeting outcome with no next step.
    if (meeting?.outcome && OPEN_MEETING_OUTCOMES.has(meeting.outcome) && !activeTypes.has('MEETING_FOLLOW_UP') && !activeActions.length) {
      const doneAfter = allActions.some((a) => upper(a.action_status) === 'COMPLETED' && upper(a.action_type) === 'MEETING_FOLLOW_UP' && (ts(a.completed_at) ?? 0) >= (ts(meeting.completed_at) ?? 0));
      if (!doneAfter) cards.push({ ...base, key: 'MEETING_OUTCOME_NO_NEXT_STEP', base: 65, commitment: true,
        headline: meeting.outcome === 'PILOT_AGREED' ? 'PILOT AGREED — NO ONBOARDING STEP' : `${upper(meeting.outcome_label)} — NO FOLLOW-UP SCHEDULED`,
        summary: `Meeting outcome “${meeting.outcome_label}” has no follow-up action.`,
        next_step: 'Schedule the follow-up so this opportunity cannot go quiet.', primary: { kind: 'meeting', label: 'Open meeting' }, due_ms: ts(meeting.follow_up_at) });
    }
    // E4 interest with nothing scheduled.
    const latest = [...replies].sort(newestFirst('received_at'))[0];
    if (latest && INTEREST_CLASSES.has(upper(latest.classification)) && !activeActions.length && pipeline !== 'MEETING_BOOKED' && !meeting) {
      const replyMs = ts(latest.received_at) ?? 0;
      const handled = calls.some((c) => (ts(c.started_at) ?? 0) > replyMs && text(c.outcome))
        || ctx.sales.some((s) => upper(s.send_outcome) === 'SENT' && (ts(s.sent_at || s.created_at) ?? 0) > replyMs)
        || allActions.some((a) => upper(a.action_status) === 'COMPLETED' && (ts(a.completed_at) ?? 0) > replyMs);
      if (!handled) cards.push({ ...base, key: 'INTEREST_NO_NEXT_STEP', base: 65, commitment: true, headline: 'INTERESTED — BUT NOTHING IS SCHEDULED',
        summary: `${REPLY_WORDS[upper(latest.classification)] || 'Positive reply'} ${londonDayName(replyMs, nowMs)}: “${short(latest.cleaned_reply_text || latest.body_text, 160)}”`,
        next_step: 'Reply or call today and book a discovery meeting.', primary: { kind: 'reply', label: 'Open & reply' }, due_ms: replyMs });
    }
    // E5 a saved call whose follow-ups never landed.
    const pending = calls.find((c) => text(c.outcome) && meta(c).followups === 'PENDING');
    if (pending) cards.push({ ...base, key: 'CALL_FOLLOWUPS_PENDING', base: 60, commitment: true, headline: 'CALL SAVED — NEXT STEP WAS NOT CREATED',
      summary: `The ${OUTCOME_WORDS[upper(pending.outcome)] || pending.outcome} call ${londonDayName(ts(pending.started_at) ?? nowMs, nowMs)} saved, but its callback/follow-up did not write.`,
      next_step: 'Open Calling: the pending follow-up is retried from there (Repair).', primary: { kind: 'profile', label: 'Open lead' }, due_ms: ts(pending.started_at) });
  }
  if (unmatchedReplies.length) cards.push({ ctx: null, key: 'UNMATCHED_REPLIES', base: 45, commitment: false,
    headline: `${unmatchedReplies.length} ${unmatchedReplies.length === 1 ? 'REPLY' : 'REPLIES'} NOT MATCHED TO AN AGENCY`,
    summary: 'These replies could not be linked to a lead, so nothing is scheduled for them.',
    next_step: 'Match each one to its agency in Settings › Exceptions.', primary: { kind: 'settings', label: 'Match replies' }, due_ms: Math.max(...unmatchedReplies.map((r) => ts(r.received_at) ?? 0)) || null });
  return cards;
}

// ── the builder ─────────────────────────────────────────────────────────────
export function buildPriorities(tables, { now = new Date().toISOString(), roster = [] } = {}) {
  const nowMs = Date.parse(now) || Date.now();
  const agencies = tableRows(tables.AGENCIES);
  const agencyById = new Map(agencies.map((a) => [text(a.agency_id), a]));
  const actions = tableRows(tables.ACTIONS);
  const calls = tableRows(tables.CALLS).filter((c) => text(c.call_status).toLowerCase() !== 'discarded');
  const replies = tableRows(tables.REPLY_EVENTS);
  const sessions = tableRows(tables.DISCOVERY_SESSIONS);
  const sales = tableRows(tables.SALES_MESSAGES);
  const contacts = tableRows(tables.CONTACTS);
  const owners = new Map([...deriveLeadOwners(tables.LEAD_OWNERSHIP).owners].map(([id, o]) => [id, o.user_id]));
  const by = {
    actions: groupBy(actions, 'agency_id'), calls: groupBy(calls, 'agency_id'), replies: groupBy(replies, 'agency_id'),
    sessions: groupBy(sessions, 'agency_id'), sales: groupBy(sales, 'agency_id'), contacts: groupBy(contacts, 'agency_id'),
  };

  // Which agencies matter: any with an active human action, plus any with
  // evidence of a live opportunity (reply, meeting, call) for the exception checks.
  const humanActive = (a) => ACTIVE.has(upper(a.action_status)) && ['JOE', 'CALLING'].includes(actionQueue(a));
  const relevant = new Set([
    ...actions.filter(humanActive).map((a) => text(a.agency_id)),
    ...sessions.map((s) => text(s.agency_id)),
    ...calls.filter((c) => text(c.outcome)).map((c) => text(c.agency_id)),
    ...replies.filter((r) => INTEREST_CLASSES.has(upper(r.classification))).map((r) => text(r.agency_id)),
    ...agencies.filter((a) => upper(a.current_pipeline_status) === 'MEETING_BOOKED').map((a) => text(a.agency_id)),
  ].filter((id) => id && agencyById.has(id)));

  const ctxByAgency = new Map();
  for (const id of relevant) {
    const agency = agencyById.get(id);
    const allActions = by.actions.get(id) || [];
    const agencyCalls = (by.calls.get(id) || []).sort(newestFirst('started_at'));
    const ctx = {
      agency, allActions, activeActions: allActions.filter(humanActive),
      calls: agencyCalls, replies: by.replies.get(id) || [], sessions: by.sessions.get(id) || [], sales: by.sales.get(id) || [], contacts: by.contacts.get(id) || [],
      owner: owners.get(id) || '', nowMs,
    };
    ctx.meeting = meetingFor({ calls: agencyCalls, sessions: ctx.sessions, actions: allActions });
    ctx.touch = lastTouch(ctx);
    const live = agencyCalls.find((c) => !text(c.outcome) && (ts(c.started_at) ?? 0) > nowMs - IN_PROGRESS_WINDOW_MS);
    ctx.in_progress = live ? { user_id: text(meta(live).user_id) || 'admin', since: text(live.started_at) } : null;
    ctxByAgency.set(id, ctx);
  }

  const raw = [];
  for (const ctx of ctxByAgency.values()) {
    for (const action of ctx.activeActions) {
      const m = meta(action);
      const call = ctx.calls.find((c) => text(c.call_id) === text(m.call_id)) || ctx.calls.find((c) => text(c.outcome)) || null;
      const reply = ctx.replies.find((r) => text(r.reply_event_id) === text(action.reply_event_id || m.reply_event_id)) || [...ctx.replies].sort(newestFirst('received_at'))[0] || null;
      const contact = bestContact({ agency: ctx.agency, contacts: ctx.contacts, action, call });
      const sit = situationFor(action, { contact, call, reply, meeting: ctx.meeting, nowMs });
      // SNOOZED is "rescheduled": its due_at is the new time.
      let dueMs = ts(action.due_at);
      // Meeting work is timed by the meeting, not by when the prep task was filed.
      const meetingMs = ts(m.meeting_at) ?? ts(ctx.meeting?.at);
      if (sit.key === 'MEETING_OUTCOME_MISSING' && meetingMs !== null) dueMs = meetingMs + MEETING_GRACE_MS;
      raw.push({ ctx, action, sit, contact, call, reply, dueMs, assignee: text(m.assigned_user_id) || ctx.owner, assignee_explicit: Boolean(text(m.assigned_user_id)) });
    }
  }
  const unmatchedReplies = replies.filter((r) => !text(r.agency_id) && !['OOO_AUTOMATED', 'OPT_OUT', 'NOT_INTERESTED'].includes(upper(r.classification)) && upper(r.is_auto_reply) !== 'TRUE');
  for (const exc of exceptionCards(ctxByAgency, { nowMs, unmatchedReplies })) {
    const contact = exc.ctx ? bestContact({ agency: exc.ctx.agency, contacts: exc.ctx.contacts, action: {}, call: exc.ctx.calls.find((c) => text(c.outcome)) }) : { name: '', role: '', phone: '', email: '', decision_maker: false, tier: 'UNNAMED' };
    raw.push({ ctx: exc.ctx, action: null, sit: { ...exc, headline: () => exc.headline }, contact, call: null, reply: null, dueMs: exc.due_ms ?? null,
      assignee: exc.key === 'UNMATCHED_REPLIES' ? 'admin' : (exc.ctx?.owner || ''), assignee_explicit: false });
  }

  // One card per agency: the highest-scoring item leads, the rest are "also open".
  const scored = raw.map((item) => {
    const due = dueBucket(item.dueMs, nowMs);
    const interested = ['INTERESTED_REPLY', 'CALL_REQUESTED_BY_EMAIL', 'INTEREST_NO_NEXT_STEP', 'REQUESTED_CALLBACK'].includes(item.sit.key);
    const lastMs = ts(item.ctx?.touch?.last?.at);
    const s = score(item.sit, { due, contact: item.contact, lastMeaningfulAgeDays: lastMs === null ? null : Math.floor((nowMs - lastMs) / DAY_MS), interested, test: isTestAgency(agencyName(item.ctx?.agency)) });
    return { ...item, due, score: s.score, score_reasons: s.reasons };
  });
  const byAgency = new Map();
  for (const item of scored) {
    const key = item.ctx ? text(item.ctx.agency.agency_id) : `global:${item.sit.key}`;
    if (!byAgency.has(key)) byAgency.set(key, []);
    byAgency.get(key).push(item);
  }
  const cards = [];
  for (const items of byAgency.values()) {
    // Due-now work leads over a higher-scoring future item for the same agency.
    items.sort((a, b) => (b.due.due_now - a.due.due_now) || (b.score - a.score) || ((a.dueMs ?? 0) - (b.dueMs ?? 0)));
    const [lead, ...rest] = items;
    cards.push(toCard(lead, rest, nowMs));
  }

  cards.sort((a, b) => (b.due_now - a.due_now) || (b.score - a.score) || ((ts(a.due_at) ?? 0) - (ts(b.due_at) ?? 0)));
  let firstCount = 0;
  for (const card of cards) {
    if (!card.due_now) card.tier = 'COMING_UP';
    else if (card.score >= FIRST_SCORE && firstCount < FIRST_LIMIT) { card.tier = 'FIRST'; firstCount += 1; }
    else card.tier = 'TODAY';
  }
  cards.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.tier === 'COMING_UP' ? (ts(a.due_at) ?? 0) - (ts(b.due_at) ?? 0) : (b.score - a.score)));

  const names = new Map((roster || []).map((u) => [text(u.user_id), text(u.display_name) || text(u.user_id)]));
  const counts = {
    first: cards.filter((c) => c.tier === 'FIRST').length,
    today: cards.filter((c) => c.tier === 'TODAY').length,
    coming_up: cards.filter((c) => c.tier === 'COMING_UP').length,
    overdue: cards.filter((c) => c.overdue).length,
    issues: cards.filter((c) => c.kind === 'exception').length,
    unassigned: cards.filter((c) => !c.assignee_id && c.due_now).length,
    by_assignee: Object.fromEntries([...new Set(cards.map((c) => c.assignee_id))].map((id) => [id || 'unassigned', cards.filter((c) => c.assignee_id === id && c.due_now).length])),
  };
  return { generated_at: new Date(nowMs).toISOString(), items: cards, counts, roster: [...names].map(([user_id, display_name]) => ({ user_id, display_name })), scoreboard: buildScoreboard({ calls, sessions, actions, agencyById, replies, nowMs }) };
}
const tierRank = (t) => ({ FIRST: 0, TODAY: 1, COMING_UP: 2 })[t] ?? 3;

function toCard(item, rest, nowMs) {
  const { ctx, action, sit, contact, call, reply, due } = item;
  const m = meta(action);
  const agency = ctx?.agency || {};
  const headline = sit.headline(due.day === 'later' || due.day === 'tomorrow' ? londonDayName(item.dueMs, nowMs) : due.day);
  const facts = [];
  if (call) {
    const by = text(meta(call).user_id) || 'admin';
    facts.push({ at: text(call.started_at), by, label: 'Last call', text: [OUTCOME_WORDS[upper(call.outcome)] || text(call.outcome), text(call.contact_name) && `spoke with ${text(call.contact_name)}${text(call.contact_role) ? ` (${text(call.contact_role)})` : ''}`].filter(Boolean).join(' — ') });
    for (const [label, value] of [['They asked', call.callback_note], ['Information requested', call.more_info_type && (MORE_INFO_WORDS[upper(call.more_info_type)] || call.more_info_type)], ['Call note', call.useful_note], ['Meeting note', call.meeting_note], ['Their priority', call.main_priority && text(call.main_priority).replace(/_/g, ' ').toLowerCase()], ['Their constraint', call.main_constraint && text(call.main_constraint).replace(/_/g, ' ').toLowerCase()]]) {
      if (text(value)) facts.push({ at: text(call.started_at), by, label, text: short(value, 400) });
    }
    if (text(call.objections)) facts.push({ at: text(call.started_at), by, label: 'Objections raised', text: short(call.objections, 300) });
  }
  if (reply && ['reply', 'call', 'meeting'].includes(sit.primary.kind)) {
    facts.push({ at: text(reply.received_at), by: '', label: `Their email (${REPLY_WORDS[upper(reply.classification)] || 'reply'})`, text: short(reply.cleaned_reply_text || reply.body_text, 500) });
  }
  const objections = [...new Set((ctx?.calls || []).flatMap((c) => text(c.objections).split(/[;,|]/).map(text)).filter(Boolean))].slice(0, 6);
  const notInterested = (ctx?.calls || []).map((c) => text(c.not_interested_reason)).filter(Boolean);
  const promised = action && upper(action.action_type) === 'SEND_INFORMATION' ? `We promised ${MORE_INFO_WORDS[upper(m.more_info_type)] || 'information'}` : (sit.commitment && action ? `Agreed to ${sit.key === 'REQUESTED_CALLBACK' ? 'call back' : 'follow up'}${item.dueMs !== null ? ` ${londonDayName(item.dueMs, nowMs)}` : ''}` : '');
  const card = {
    id: action ? text(action.action_id) : `exc:${sit.key}:${text(agency.agency_id) || 'global'}`,
    kind: action ? 'action' : 'exception',
    agency_id: text(agency.agency_id), agency_name: ctx ? agencyName(agency) : 'Inbox', location: text(agency.location),
    is_test: isTestAgency(agencyName(agency)) && Boolean(ctx),
    action_id: action ? text(action.action_id) : '', action_type: action ? upper(action.action_type) : '',
    situation: sit.key, headline, summary: sit.summary, next_step: sit.next_step, primary: sit.primary,
    due_at: item.dueMs === null ? '' : new Date(item.dueMs).toISOString(), due_day: due.day, due_now: due.due_now, overdue: due.overdue, overdue_days: due.overdue_days,
    no_deadline: Boolean(action) && item.dueMs === null,
    score: item.score, score_reasons: item.score_reasons, tier: '',
    assignee_id: item.assignee, assignee_explicit: item.assignee_explicit, owner_id: ctx?.owner || '',
    // A meeting keeps who BOOKED it apart from who RUNS it (the assignee).
    booked_by_id: action && upper(action.action_type) === 'PREPARE_MEETING' ? text(m.handover?.booked_by) : '',
    calling_action: action ? isCallingWorkflowAction(action) : false,
    contact,
    last_contact: ctx?.touch?.last || null,
    recent: ctx?.touch?.recent || [],
    facts, objections, not_interested_reasons: notInterested, promised,
    requested: text(m.callback_note || m.more_info_type || (reply && INTEREST_CLASSES.has(upper(reply.classification)) ? REPLY_WORDS[upper(reply.classification)] : '')),
    meeting: ctx?.meeting || null,
    in_progress: ctx?.in_progress || null,
    suppressed: upper(agency.suppression_status) === 'SUPPRESSED',
    also_open: rest.map((r) => ({ id: r.action ? text(r.action.action_id) : `exc:${r.sit.key}`, action_id: r.action ? text(r.action.action_id) : '', headline: r.sit.headline(r.due.day === 'later' || r.due.day === 'tomorrow' ? londonDayName(r.dueMs, nowMs) : r.due.day), due_at: r.dueMs === null ? '' : new Date(r.dueMs).toISOString(), assignee_id: r.assignee, overdue: r.due.overdue })),
    debug: action ? { action_id: text(action.action_id), action_type: text(action.action_type), action_status: text(action.action_status), action_owner: text(action.action_owner), source_stage: text(action.source_stage), dedupe_key: text(action.dedupe_key), reason: text(action.reason), created_at: text(action.created_at), queue: actionQueue(action), metadata: m } : { exception: sit.key },
  };
  return card;
}

// ── scoreboard: collective results first, activity second ──────────────────
// London weeks (Mon–Sun). TEST agencies are excluded.
export function londonWeekStart(ms) {
  const day = londonDayNumber(ms);
  const weekday = new Date(day * DAY_MS).getUTCDay(); // London calendar weekday
  return day - ((weekday + 6) % 7);
}
function buildScoreboard({ calls, sessions, actions, agencyById, replies, nowMs }) {
  const real = (row) => !isTestAgency(agencyName(agencyById.get(text(row.agency_id))));
  const thisWeek = londonWeekStart(nowMs);
  const inWeek = (value, start) => { const ms = ts(value); if (ms === null) return false; const d = londonDayNumber(ms); return d >= start && d < start + 7; };
  const dialled = calls.filter((c) => text(c.outcome) && real(c));
  const people = new Map();
  const bump = (id, key) => { const p = people.get(id) || { user_id: id, calls: 0, connected: 0, decision_makers: 0, conversations: 0, meetings_booked: 0, callbacks_done: 0, callbacks_due: 0 }; p[key] += 1; people.set(id, p); };
  const week = (start) => {
    const w = { calls: 0, connected: 0, decision_makers: 0, conversations: 0, meetings_booked: 0, meetings_held: 0, proposals: 0, pilots: 0, follow_ups_done: 0, follow_ups_late: 0 };
    for (const c of dialled.filter((x) => inWeek(x.started_at, start))) {
      w.calls += 1;
      if (upper(c.connected) === 'TRUE') w.connected += 1;
      if (upper(c.owner_reached) === 'TRUE') w.decision_makers += 1;
      if (upper(c.pitched) === 'TRUE') w.conversations += 1;
      if (upper(c.outcome) === 'BOOKED_MEETING') w.meetings_booked += 1;
    }
    for (const s of sessions.filter((x) => real(x) && upper(x.outcome) && inWeek(x.meeting_at || x.completed_at, start))) {
      w.meetings_held += 1;
      if (['PROPOSAL_REQUESTED', 'PILOT_AGREED'].includes(upper(s.outcome))) w.proposals += 1;
      if (upper(s.outcome) === 'PILOT_AGREED') w.pilots += 1;
    }
    for (const a of actions.filter((x) => real(x) && ['JOE', 'CALLING'].includes(actionQueue(x)))) {
      if (upper(a.action_status) === 'COMPLETED' && inWeek(a.completed_at, start)) {
        w.follow_ups_done += 1;
        if ((ts(a.completed_at) ?? 0) > (ts(a.due_at) ?? Infinity) + DAY_MS) w.follow_ups_late += 1;
      }
    }
    return w;
  };
  for (const c of dialled.filter((x) => inWeek(x.started_at, thisWeek))) {
    const id = text(meta(c).user_id) || 'admin';
    bump(id, 'calls');
    if (upper(c.connected) === 'TRUE') bump(id, 'connected');
    if (upper(c.owner_reached) === 'TRUE') bump(id, 'decision_makers');
    if (upper(c.pitched) === 'TRUE') bump(id, 'conversations');
    if (upper(c.outcome) === 'BOOKED_MEETING') bump(id, 'meetings_booked');
  }
  for (const a of actions.filter((x) => real(x) && isCallingWorkflowAction(x))) {
    const id = text(meta(a).assigned_user_id) || 'admin';
    if (inWeek(a.due_at, thisWeek) || (ts(a.due_at) ?? Infinity) < nowMs && ACTIVE.has(upper(a.action_status))) bump(id, 'callbacks_due');
    if (upper(a.action_status) === 'COMPLETED' && inWeek(a.completed_at, thisWeek)) bump(id, 'callbacks_done');
  }

  // All-time funnel, agencies not events.
  const agenciesWhere = (rows, test) => new Set(rows.filter((r) => real(r) && test(r)).map((r) => text(r.agency_id)));
  const contacted = new Set([...agenciesWhere(dialled, () => true), ...agenciesWhere(replies, () => true)]);
  const connected = agenciesWhere(dialled, (c) => upper(c.connected) === 'TRUE');
  const interested = new Set([...agenciesWhere(replies, (r) => INTEREST_CLASSES.has(upper(r.classification))), ...agenciesWhere(dialled, (c) => ['CALLBACK_REQUESTED', 'MORE_INFO_REQUESTED', 'BOOKED_MEETING'].includes(upper(c.outcome)))]);
  const booked = new Set([...agenciesWhere(dialled, (c) => upper(c.outcome) === 'BOOKED_MEETING'), ...[...agencyById.values()].filter((a) => upper(a.current_pipeline_status) === 'MEETING_BOOKED' && real(a)).map((a) => text(a.agency_id))]);
  const attended = agenciesWhere(sessions, (s) => upper(s.outcome) && !['NO_SHOW'].includes(upper(s.outcome)));
  const qualified = agenciesWhere(sessions, (s) => OPEN_MEETING_OUTCOMES.has(upper(s.outcome)));
  const proposals = agenciesWhere(sessions, (s) => ['PROPOSAL_REQUESTED', 'PILOT_AGREED'].includes(upper(s.outcome)));
  const pilots = agenciesWhere(sessions, (s) => upper(s.outcome) === 'PILOT_AGREED');
  const steps = [['Contacted', contacted], ['Connected', connected], ['Interested', interested], ['Meeting booked', booked], ['Meeting attended', attended], ['Qualified opportunity', qualified], ['Proposal', proposals], ['Paid pilot', pilots]];
  const funnel = steps.map(([label, set], i) => ({ label, count: set.size, rate_from_previous: i === 0 || !steps[i - 1][1].size ? null : Math.round((set.size / steps[i - 1][1].size) * 100) }));
  const lost = {};
  for (const c of dialled.filter((x) => upper(x.outcome) === 'NOT_INTERESTED')) { const k = text(c.not_interested_reason) || 'UNSPECIFIED'; lost[k] = (lost[k] || 0) + 1; }
  for (const s of sessions.filter((x) => real(x) && ['NOT_INTERESTED', 'NOT_SUITABLE'].includes(upper(x.outcome)))) { const k = `MEETING_${upper(s.outcome)}`; lost[k] = (lost[k] || 0) + 1; }
  return {
    week_start: new Date(thisWeek * DAY_MS).toISOString().slice(0, 10),
    this_week: week(thisWeek), last_week: week(thisWeek - 7),
    people: [...people.values()],
    funnel,
    lost_reasons: Object.entries(lost).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    note: 'Contacted counts agencies we called or that replied to email; email sends are on the Email page.',
  };
}

export const _internal = { situationFor, score, dueBucket, bestContact, meetingFor, exceptionCards, londonDayName };
