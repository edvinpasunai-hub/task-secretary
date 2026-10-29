// Turns a wall-clock time in a named time zone ("2026-03-29 03:30 in
// Europe/Tallinn") into a real instant. Recurrence uses instants ONLY to decide
// which of two moments is later; the dates and times that get stored always
// stay as the wall-clock values the user chose.
//
// Daylight saving policy (deterministic, so the same input always gives the
// same answer):
// - A wall time that does not exist (the clocks jumped forward over it) is
//   shifted forward by the length of the gap: Tallinn 2026-03-29 03:30 → 04:30.
// - A wall time that happens twice (the clocks went back) means its FIRST
//   occurrence, the earlier instant: Tallinn 2026-10-25 03:30 → the EEST one.

import type { LocalDate, LocalTime } from "@/lib/local-time";

const formatters = new Map<string, Intl.DateTimeFormat>();

// The zone's offset from UTC, in minutes, at the given instant (+180 = UTC+3).
export function offsetMinutesAt(utcMs: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset", hour: "numeric" });
    formatters.set(timeZone, formatter);
  }
  const name = formatter.formatToParts(new Date(utcMs)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!match || !match[1]) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function wallClockToInstant(date: LocalDate, time: LocalTime, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  // The wall clock read as if it were UTC. Date.UTC only converts calendar
  // fields to milliseconds; no local time zone is involved.
  const naive = Date.UTC(year, month - 1, day, hour, minute);

  // A transition is at most once a day, so the offsets one day either side
  // cover every offset that could apply to this wall time.
  const before = offsetMinutesAt(naive - DAY_MS, timeZone);
  const after = offsetMinutesAt(naive + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => naive - offset * 60000)
    .filter((instant) => offsetMinutesAt(instant, timeZone) === (naive - instant) / 60000);

  if (valid.length === 0) return naive - before * 60000; // in the gap: shift forward
  return Math.min(...valid); // normal time, or the first of two
}
