// Details attached to a CALL_REQUESTED action. Classification remains in
// reply-classification.mjs; this module only extracts dial and timing evidence.
import { normalizePhoneNumber } from './lead-search.mjs';
import { londonParts, londonTimeOn, londonWeekday } from './london-time.mjs';

const text = (value) => String(value ?? '').trim();
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function replyPhoneNumbers(body) {
  const found = [];
  // A leading UK 0 or +44 and ten or eleven total domestic digits. Boundaries
  // keep dates, postcodes and fragments of longer numbers out of the result.
  const pattern = /(?<![\w+])(?:\+44[\s().-]*\(?0?\)?[\s().-]*|0)(?:\d[\s().-]*){9,10}(?!\d)/g;
  for (const match of text(body).matchAll(pattern)) {
    const raw = match[0].trim().replace(/[.\s-]+$/, '');
    const normalised = normalizePhoneNumber(raw);
    if (/^\+44\d{9,10}$/.test(normalised) && !found.some((item) => item.normalised === normalised)) {
      found.push({ raw, normalised, source: 'EMAIL_REPLY' });
    }
  }
  return found;
}

export function replyCallbackTiming(body, receivedAt, now = new Date().toISOString()) {
  const value = text(body);
  const lower = value.toLowerCase();
  const receivedMs = Date.parse(receivedAt) || Date.parse(now);
  const nowMs = Date.parse(now);
  const relative = lower.match(/\b(today|tomorrow|next week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  const clock = lower.match(/\b(?:at|after)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const period = lower.match(/\b(morning|afternoon|evening)\b/);
  const whenever = /\b(whenever|anytime|any time)\b/.test(lower) && !relative && !clock && !period;
  if (!relative && !clock && !period) return { language: whenever ? 'whenever' : '', due_at: now, precision: 'NOW', needs_review: false };

  let dayOffset = 0;
  if (relative?.[1] === 'tomorrow') dayOffset = 1;
  else if (WEEKDAYS.includes(relative?.[1])) {
    const current = londonParts(receivedMs);
    const currentDay = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
    dayOffset = (WEEKDAYS.indexOf(relative[1]) - currentDay + 7) % 7 || 7;
  } else if (relative?.[1] === 'next week') {
    const current = londonParts(receivedMs);
    const currentDay = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
    dayOffset = 7 - ((currentDay + 6) % 7);
  } else if (relative?.[1] === 'next month') {
    const p = londonParts(receivedMs);
    let firstDay = Date.UTC(p.year, p.month, 1, 12);
    while ([0, 6].includes(londonWeekday(firstDay))) firstDay += 86_400_000;
    const dueMs = londonTimeOn(firstDay, { hour: 9 });
    return { language: value, due_at: dueMs > nowMs ? new Date(dueMs).toISOString() : '',
      precision: 'BROAD', needs_review: true, ...(dueMs <= nowMs ? { warning: 'Requested month has passed' } : {}) };
  }
  let hour = period?.[1] === 'afternoon' ? 12 : period?.[1] === 'evening' ? 17 : 9;
  let minute = 0;
  if (clock) {
    hour = Number(clock[1]); minute = Number(clock[2] || 0);
    if (clock[3] === 'pm' && hour < 12) hour += 12;
    if (clock[3] === 'am' && hour === 12) hour = 0;
    if (!clock[3] && hour >= 1 && hour <= 6 && period?.[1] !== 'morning') hour += 12;
    if (hour > 23 || minute > 59) return { language: value, due_at: '', precision: 'AMBIGUOUS', needs_review: true };
  }
  if (!relative && (clock || period)) {
    // An hour without a day is a preference for today only while it is still
    // ahead. Otherwise keep it unscheduled for review, not tomorrow by fiat.
    const todayMs = londonTimeOn(receivedMs, { hour, minute });
    return { language: value, due_at: todayMs > nowMs ? new Date(todayMs).toISOString() : '',
      precision: 'AMBIGUOUS', needs_review: true, ...(todayMs <= nowMs ? { warning: 'Requested time has passed or day is unclear' } : {}) };
  }
  const dueMs = londonTimeOn(receivedMs, { hour, minute, addDays: dayOffset });
  const past = dueMs < nowMs - 60_000;
  return {
    language: value,
    due_at: past ? '' : new Date(dueMs).toISOString(),
    precision: clock && !/\bafter\b/.test(clock[0]) ? 'EXACT' : 'WINDOW',
    needs_review: past || Boolean(!clock || /\bafter\b/.test(clock?.[0] || '')),
    ...(past ? { warning: 'Requested time has passed' } : {}),
  };
}
