// lib/london-time.mjs — Europe/London wall-clock arithmetic for scheduling.
//
// Timestamps are stored in UTC everywhere in the workbook; what must NOT be
// UTC is the *intent* "call them back at 09:00 tomorrow". A hard-coded UTC
// hour drifts by an hour across the BST/GMT change, so the automatic
// callbacks and retries are computed here against the London wall clock and
// only then converted to the UTC instant that is stored. Pure Intl, no
// dependency.

export const LONDON_TZ = 'Europe/London';
const DAY_MS = 86_400_000;

const FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// The London wall-clock parts of a UTC instant.
export function londonParts(ms) {
  const parts = Object.fromEntries(FORMAT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

// Offset (ms) London is ahead of UTC at a given instant: 0 in GMT, 3_600_000 in BST.
export function londonOffsetMs(ms) {
  const p = londonParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// A London calendar day as an integer (days since epoch of that local date),
// so "overdue = due before today" compares London dates, not UTC ones.
export function londonDayNumber(ms) {
  const p = londonParts(ms);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

// 0 = Sunday … 6 = Saturday, of the London calendar date.
export function londonWeekday(ms) {
  const p = londonParts(ms);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

// The UTC instant of `hour:minute` London time on the London date of `ms`
// (plus `addDays` calendar days). Two-pass so a target that straddles the
// DST switch still lands on the right wall-clock hour.
export function londonTimeOn(ms, { hour = 9, minute = 0, addDays = 0 } = {}) {
  const p = londonParts(ms);
  const wall = Date.UTC(p.year, p.month - 1, p.day + addDays, hour, minute, 0);
  let instant = wall - londonOffsetMs(wall);
  const offset = londonOffsetMs(instant);
  if (offset !== londonOffsetMs(wall)) instant = wall - offset;
  return instant;
}

// The next London calendar day that is Monday–Friday, at the given time.
export function nextLondonWorkingDay(ms, { hour = 9, minute = 0 } = {}) {
  let addDays = 1;
  while (londonWeekday(londonTimeOn(ms, { hour: 12, addDays })) === 0 || londonWeekday(londonTimeOn(ms, { hour: 12, addDays })) === 6) addDays += 1;
  return londonTimeOn(ms, { hour, minute, addDays });
}

export function addLondonWorkingDays(ms, days, { hour = 9, minute = 0 } = {}) {
  let cursor = ms;
  for (let i = 0; i < days; i += 1) cursor = nextLondonWorkingDay(cursor, { hour: 12 });
  return londonTimeOn(cursor, { hour, minute });
}

export function addLondonCalendarDays(ms, days, { hour = 9, minute = 0 } = {}) {
  return londonTimeOn(ms, { hour, minute, addDays: days });
}
