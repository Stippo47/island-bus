// Which timetable runs on a day, and the holidays to warn about.
// BC Transit's feed already says which service runs on each date, so the holiday list here
// only supplies names; it never decides the timetable.
import { ymd, iso, addDays } from './util.js';

const KIND_OF_WEEKDAY = ['sunday', 'weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'saturday'];
export const KIND_NAME = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday', none: 'No service' };

function nth(y, m, weekday, n) {
  const first = new Date(y, m, 1);
  return new Date(y, m, 1 + ((weekday - first.getDay() + 7) % 7) + 7 * (n - 1));
}

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

const cache = {};
function holidays(y) {
  if (cache[y]) return cache[y];
  const e = easter(y);
  const victoria = new Date(y, 4, 24);
  while (victoria.getDay() !== 1) victoria.setDate(victoria.getDate() - 1);
  const list = [
    [new Date(y, 0, 1), "New Year's Day"],
    [nth(y, 1, 1, 3), 'Family Day'],
    [addDays(e, -2), 'Good Friday'],
    [addDays(e, 1), 'Easter Monday'],
    [victoria, 'Victoria Day'],
    [new Date(y, 6, 1), 'Canada Day'],
    [nth(y, 7, 1, 1), 'B.C. Day'],
    [nth(y, 8, 1, 1), 'Labour Day'],
    [new Date(y, 8, 30), 'Truth and Reconciliation Day'],
    [nth(y, 9, 1, 2), 'Thanksgiving'],
    [new Date(y, 10, 11), 'Remembrance Day'],
    [new Date(y, 11, 24), 'Christmas Eve'],
    [new Date(y, 11, 25), 'Christmas Day'],
    [new Date(y, 11, 26), 'Boxing Day'],
    [new Date(y, 11, 31), "New Year's Eve"],
  ];
  cache[y] = Object.fromEntries(list.map(([d, n]) => [iso(d), n]));
  return cache[y];
}

export const holidayName = d => holidays(d.getFullYear())[iso(d)] || null;

// What the buses do on a day: { kind, services:Set, holiday, special, estimated }
export function busDay(bus, d) {
  const key = ymd(d);
  const expected = KIND_OF_WEEKDAY[d.getDay()];
  const holiday = holidayName(d);
  if (key >= bus.feedStart && key <= bus.feedEnd) {
    const services = bus.days[key] || [];
    const kinds = [...new Set(services.map(s => bus.serviceKind[s]))];
    const kind = kinds.length ? kinds[0] : 'none';
    return { key, kind, expected, holiday, services: new Set(services), special: kind !== expected, estimated: false };
  }
  // Past the end of the published timetable: assume the usual timetable for that weekday,
  // and BC Transit's usual holiday pattern (none on Christmas and New Year's Day, Sunday
  // service on most stat holidays).
  let kind = expected;
  if (holiday && NO_SERVICE.includes(holiday)) kind = 'none';
  else if (holiday && !REGULAR.includes(holiday)) kind = 'sunday';
  const services = kind === 'none' ? [] : Object.entries(bus.serviceKind).filter(([, k]) => k === kind).map(([s]) => s);
  return { key, kind, expected, holiday, services: new Set(services), special: kind !== expected, estimated: true };
}
const NO_SERVICE = ['Christmas Day', "New Year's Day"];
const REGULAR = ['Easter Monday', 'Christmas Eve', "New Year's Eve"];

// One line about the day, or null when it's an ordinary one.
export function busWarning(day) {
  if (day.estimated && (day.special || day.kind === 'none')) {
    return { level: 'warn', text: `${day.holiday} — BC Transit hasn't published this far ahead; buses will most likely run ${day.kind === 'none' ? 'no service' : `the ${KIND_NAME[day.kind]} schedule`}.` };
  }
  if (day.kind === 'none') return { level: 'bad', text: `${day.holiday || 'No service'} — no buses run today.`.replace(' today', '') };
  if (day.special) return { level: 'warn', text: `${day.holiday || 'Holiday'} — buses run the ${KIND_NAME[day.kind]} schedule.` };
  if (day.holiday) return { level: 'info', text: `${day.holiday} — regular ${KIND_NAME[day.kind].toLowerCase()} buses.` };
  if (day.estimated) return { level: 'info', text: `BC Transit hasn't published this far ahead yet; showing the usual ${KIND_NAME[day.kind].toLowerCase()} timetable.` };
  return null;
}

// Special days coming up soon (to warn about from today's view).
export function upcoming(bus, from, days = 10) {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(from, i);
    const day = busDay(bus, d);
    if (day.kind === 'none' || day.special) out.push({ date: d, day });
  }
  return out;
}
