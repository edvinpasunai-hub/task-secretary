// Calendar-date arithmetic on "YYYY-MM-DD" strings, done with plain integer
// math (the "days from civil" algorithm). No Date objects are involved, so no
// time zone, daylight saving change or millisecond rounding can ever creep into
// "add 3 days" or "the last day of February".

import type { LocalDate } from "@/lib/local-time";

type Civil = { year: number; month: number; day: number };

export function parseCivil(date: LocalDate): Civil {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function formatCivil({ year, month, day }: Civil): LocalDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Days since 1970-01-01 (negative before it).
function daysFromCivil({ year, month, day }: Civil): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): Civil {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart < 10 ? monthPart + 3 : monthPart - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return formatCivil(civilFromDays(daysFromCivil(parseCivil(date)) + days));
}

// Whole calendar days from `from` to `to` (positive when `to` is later).
export function diffDays(to: LocalDate, from: LocalDate): number {
  return daysFromCivil(parseCivil(to)) - daysFromCivil(parseCivil(from));
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// ISO weekday: 1 = Monday … 7 = Sunday. (1970-01-01 was a Thursday.)
export function isoWeekday(date: LocalDate): number {
  const days = daysFromCivil(parseCivil(date));
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

// The date in the given month whose day-of-month is `targetDay`, or the last
// day of that month when it is shorter (31 → 28/29/30).
export function clampDayToMonth(year: number, month: number, targetDay: number): LocalDate {
  return formatCivil({ year, month, day: Math.min(targetDay, daysInMonth(year, month)) });
}
