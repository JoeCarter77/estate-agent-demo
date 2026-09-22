// Details attached to a CALL_REQUESTED action. Classification remains in
// reply-classification.mjs; this module only extracts dial and timing evidence.
import { normalizePhoneNumber } from './lead-search.mjs';
import { londonParts, londonTimeOn, londonWeekday } from './london-time.mjs';
import { normaliseEmailBodyText } from './reply-router.mjs';

const text = (value) => String(value ?? '').trim();
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function replyPhoneNumbers(body) {
  const found = [];
  // Only the prospect's newly authored answer can supply a callback number.
  // A quoted earlier mail, signature or property-address line is context,
  // never consent to dial that number.
  const normalised = normaliseEmailBodyText(body);
  const authored = /^(?:\s*>|\s*on\s+\w+[\s\S]{0,300}\bwrote:|\s*from:\s*[^\n]+\n\s*(?:sent|date|to|subject):)/i.test(normalised) ? ''
    : normalised.split(/\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2})[\s\S]{0,300}?\bwrote:|-{2,}\s*Original Message\s*-{2,}|\n\s*>|\n\s*From:.{0,200}\n\s*(?:Sent|Date|To|Subject):/i)[0]
      .split(/\n\s*(?:--\s*$|sent from my|kind regards\b|best regards\b|regards\b|cheers\b|thanks\b|thank you\b)/im)[0];
  // A leading UK 0 or +44 and ten or eleven total domestic digits. Boundaries
  // keep dates, postcodes and fragments of longer numbers out of the result.
  const pattern = /(?<![\w+])(?:\+44[\s().-]*\(?0?\)?[\s().-]*|0)(?:\d[\s().-]*){9,10}(?!\d)/g;
  for (const match of text(authored).matchAll(pattern)) {
    const line = authored.slice(authored.lastIndexOf('\n', match.index) + 1, authored.indexOf('\n', match.index) < 0 ? undefined : authored.indexOf('\n', match.index));
    if (/\b(?:property address|address|postcode)\s*(?::|is\b|at\b)|\bproperty\s+(?:is|at)\b/i.test(line)
        && !/\b(?:call|ring|phone|mobile|number)\b/i.test(line)) continue;
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
  const absolute = lower.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s/-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2})[\s/-]*(\d{4})?\b/);
  if (absolute) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const month = /^\d+$/.test(absolute[2]) ? Number(absolute[2]) : months.indexOf(absolute[2].slice(0, 3)) + 1;
    const received = londonParts(receivedMs);
    const year = Number(absolute[3] || received.year);
    const day = Number(absolute[1]);
    const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31 && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
    if (valid) {
      let hour = period?.[1] === 'afternoon' ? 12 : period?.[1] === 'evening' ? 17 : 9;
      let minute = 0;
      if (clock) { hour = Number(clock[1]); minute = Number(clock[2] || 0); if (clock[3] === 'pm' && hour < 12) hour += 12; if (!clock[3] && hour >= 1 && hour <= 6) hour += 12; }
      const dueMs = londonTimeOn(Date.UTC(year, month - 1, day, 12), { hour, minute });
      return { language: value, due_at: dueMs > nowMs ? new Date(dueMs).toISOString() : '', precision: clock ? 'EXACT' : 'WINDOW', needs_review: !clock || dueMs <= nowMs, ...(dueMs <= nowMs ? { warning: 'Requested time has passed' } : {}) };
    }
  }
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
