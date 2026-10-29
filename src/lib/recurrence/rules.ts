// The recurrence engine: pure functions (no database, no clock of their own).
// Every date is a "YYYY-MM-DD" string and every time a "HH:MM" wall-clock
// string; "now" is always passed in so results are reproducible in tests.
//
// Time-zone behaviour (Europe/Tallinn): date-only schedules never touch a time
// zone at all. Timed schedules keep their wall-clock time across daylight
// saving changes; instants (see zoned-time.ts) are only used to order moments.
//
// Date-only vs timed: a series is one or the other. Changing between them is not
// supported in Stage 4.3.1 (planned for Stage 4.3.2, see service.ts).

import { addDays, daysInMonth, diffDays, isoWeekday, parseCivil } from "@/lib/recurrence/civil-date";
import { wallClockToInstant } from "@/lib/recurrence/zoned-time";
import { isValidLocalDate, isValidLocalTime, type LocalDate, type LocalNow, type LocalTime } from "@/lib/local-time";

export const RECURRENCE_TIME_ZONE = "Europe/Tallinn";

export const RECURRENCE_TYPES = ["DAILY", "WEEKLY", "MONTHLY", "CUSTOM_WEEKDAYS"] as const;
export type RecurrenceTypeName = (typeof RECURRENCE_TYPES)[number];

// How far a deadline may be from the planned date, in calendar days.
export const MAX_DEADLINE_OFFSET_DAYS = 3650;

// More than the longest gap between two occurrences of any supported rule
// (monthly: at most 62 days), with plenty of room to spare.
const SEARCH_LIMIT_DAYS = 800;

export type RuleConfig = {
  type: RecurrenceTypeName;
  // ISO weekdays, 1 = Monday … 7 = Sunday. WEEKLY has exactly one (the original
  // weekday), CUSTOM_WEEKDAYS one or more, DAILY and MONTHLY none.
  weekdays: number[];
  // The ORIGINAL day of the month (1-31); shorter months use their last day, but
  // the original value is never changed (Jan 31 → Feb 28 → Mar 31).
  monthlyDay: number | null;
  // Planned date of the first instance.
  anchorDate: LocalDate;
  // null = date-only series.
  plannedTime: LocalTime | null;
  // Last date an occurrence may fall on (inclusive).
  endDate: LocalDate | null;
  // Deadline = planned date + this many calendar days (may be 0 or negative),
  // at deadlineTime (null = the whole day). null offset = no deadline.
  deadlineOffsetDays: number | null;
  deadlineTime: LocalTime | null;
};

export type Occurrence = {
  // "2026-11-09" or "2026-11-09T09:00": the identity of this scheduled occurrence.
  key: string;
  date: LocalDate;
  time: LocalTime | null;
};

// A moment on the wall clock; time null = "the date only".
export type Point = { date: LocalDate; time: LocalTime | null };

export function buildOccurrence(date: LocalDate, time: LocalTime | null): Occurrence {
  return { key: time ? `${date}T${time}` : date, date, time };
}

export function parseOccurrenceKey(key: string): Occurrence {
  const [date, time] = key.split("T");
  return buildOccurrence(date, time ?? null);
}

export function isOccurrenceKey(value: string): boolean {
  const [date, time, ...rest] = value.split("T");
  return rest.length === 0 && isValidLocalDate(date) && (time === undefined || isValidLocalTime(time));
}

// Orders occurrence keys by date, then time (a date-only key counts as 00:00).
export function compareOccurrenceKeys(a: string, b: string): number {
  const left = parseOccurrenceKey(a);
  const right = parseOccurrenceKey(b);
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  const leftTime = left.time ?? "00:00";
  const rightTime = right.time ?? "00:00";
  return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type RuleIssue = { field: keyof RuleConfig; code: string; message: string };

export function normalizeWeekdays(weekdays: readonly number[]): number[] {
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

// Is this date one of the rule's scheduled dates? (Not before the anchor; the
// end date is checked separately.)
export function occursOn(rule: RuleConfig, date: LocalDate): boolean {
  if (date < rule.anchorDate) return false;
  switch (rule.type) {
    case "DAILY":
      return true;
    case "WEEKLY":
    case "CUSTOM_WEEKDAYS":
      return rule.weekdays.includes(isoWeekday(date));
    case "MONTHLY": {
      const { year, month, day } = parseCivil(date);
      return rule.monthlyDay !== null && day === Math.min(rule.monthlyDay, daysInMonth(year, month));
    }
  }
}

// Builds a rule from a planned date: WEEKLY adopts its weekday, MONTHLY its day
// of the month. CUSTOM_WEEKDAYS needs the weekdays passed in.
export function ruleFromAnchor(
  type: RecurrenceTypeName,
  anchorDate: LocalDate,
  options: Partial<Pick<RuleConfig, "weekdays" | "plannedTime" | "endDate" | "deadlineOffsetDays" | "deadlineTime">> = {},
): RuleConfig {
  return {
    type,
    weekdays: type === "WEEKLY" ? [isoWeekday(anchorDate)] : type === "CUSTOM_WEEKDAYS" ? normalizeWeekdays(options.weekdays ?? []) : [],
    monthlyDay: type === "MONTHLY" ? parseCivil(anchorDate).day : null,
    anchorDate,
    plannedTime: options.plannedTime ?? null,
    endDate: options.endDate ?? null,
    deadlineOffsetDays: options.deadlineOffsetDays ?? null,
    deadlineTime: options.deadlineTime ?? null,
  };
}

export function validateRule(rule: RuleConfig): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const add = (field: keyof RuleConfig, code: string, message: string) => issues.push({ field, code, message });

  if (!RECURRENCE_TYPES.includes(rule.type)) add("type", "INVALID_TYPE", "Please choose how often the task repeats.");

  const weekdaysOk = rule.weekdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) && new Set(rule.weekdays).size === rule.weekdays.length;
  if (!weekdaysOk) add("weekdays", "INVALID_WEEKDAYS", "Weekdays must be unique numbers from 1 (Monday) to 7 (Sunday).");
  if (rule.type === "WEEKLY" && rule.weekdays.length !== 1) add("weekdays", "INVALID_WEEKDAYS", "A weekly task repeats on exactly one weekday.");
  if (rule.type === "CUSTOM_WEEKDAYS" && rule.weekdays.length < 1) add("weekdays", "INVALID_WEEKDAYS", "Please choose at least one weekday.");
  if ((rule.type === "DAILY" || rule.type === "MONTHLY") && rule.weekdays.length > 0) add("weekdays", "INVALID_WEEKDAYS", "This repeat type does not use weekdays.");

  if (rule.type === "MONTHLY") {
    if (!Number.isInteger(rule.monthlyDay) || rule.monthlyDay! < 1 || rule.monthlyDay! > 31) add("monthlyDay", "INVALID_MONTHLY_DAY", "The day of the month must be between 1 and 31.");
  } else if (rule.monthlyDay !== null) {
    add("monthlyDay", "INVALID_MONTHLY_DAY", "Only monthly tasks have a day of the month.");
  }

  if (!isValidLocalDate(rule.anchorDate)) add("anchorDate", "INVALID_DATE", "A recurring task needs a valid planned date.");
  if (rule.plannedTime !== null && !isValidLocalTime(rule.plannedTime)) add("plannedTime", "INVALID_TIME", "Please enter a valid time, for example 14:30.");
  if (rule.endDate !== null) {
    if (!isValidLocalDate(rule.endDate)) add("endDate", "INVALID_DATE", "Please enter a valid end date.");
    else if (isValidLocalDate(rule.anchorDate) && rule.endDate < rule.anchorDate) add("endDate", "END_BEFORE_START", "The end date cannot be before the first planned date.");
  }

  if (rule.deadlineOffsetDays !== null && (!Number.isInteger(rule.deadlineOffsetDays) || Math.abs(rule.deadlineOffsetDays) > MAX_DEADLINE_OFFSET_DAYS)) {
    add("deadlineOffsetDays", "INVALID_DEADLINE_OFFSET", `The deadline must be within ${MAX_DEADLINE_OFFSET_DAYS} days of the planned date.`);
  }
  if (rule.deadlineTime !== null) {
    if (!isValidLocalTime(rule.deadlineTime)) add("deadlineTime", "INVALID_TIME", "Please enter a valid time, for example 14:30.");
    else if (rule.deadlineOffsetDays === null) add("deadlineTime", "DEADLINE_TIME_WITHOUT_DEADLINE", "A deadline time needs a deadline.");
  }

  // The first planned date must itself be a date the rule produces, so every
  // instance's scheduled occurrence is always valid for its rule.
  if (issues.length === 0 && !occursOn(rule, rule.anchorDate)) {
    add("anchorDate", "ANCHOR_NOT_ON_SCHEDULE", "The planned date does not fall on the chosen days.");
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Next occurrence
// ---------------------------------------------------------------------------

// Where to start searching after completing an instance: the LATER of the
// completed instance's scheduled occurrence and now.
// - late completion: "now" wins, so missed occurrences are skipped, never queued;
// - early completion: the occurrence wins, so the series always moves forward
//   and the same occurrence can never be produced again.
export function referencePoint(rule: RuleConfig, completed: Occurrence | null, now: LocalNow, timeZone: string = RECURRENCE_TIME_ZONE): Point {
  const nowPoint: Point = { date: now.date, time: now.time };
  if (!completed) return rule.plannedTime === null ? { date: now.date, time: null } : nowPoint;
  if (rule.plannedTime === null) return { date: completed.date > now.date ? completed.date : now.date, time: null };

  const completedInstant = wallClockToInstant(completed.date, completed.time ?? "00:00", timeZone);
  const nowInstant = wallClockToInstant(now.date, now.time, timeZone);
  return completedInstant > nowInstant ? { date: completed.date, time: completed.time ?? "00:00" } : nowPoint;
}

// The first scheduled occurrence strictly after `reference`, or null when the
// end date has been passed.
// - date-only series: a LATER calendar date (never the same date);
// - timed series: a later INSTANT, so a later time on the same day counts.
export function nextOccurrenceAfter(rule: RuleConfig, reference: Point, timeZone: string = RECURRENCE_TIME_ZONE): Occurrence | null {
  const timed = rule.plannedTime !== null;
  const referenceInstant = timed ? wallClockToInstant(reference.date, reference.time ?? "00:00", timeZone) : 0;

  let day = timed ? reference.date : addDays(reference.date, 1);
  if (day < rule.anchorDate) day = rule.anchorDate;

  for (let checked = 0; checked < SEARCH_LIMIT_DAYS; checked++, day = addDays(day, 1)) {
    if (rule.endDate !== null && day > rule.endDate) return null;
    if (!occursOn(rule, day)) continue;
    if (!timed) return buildOccurrence(day, null);
    if (wallClockToInstant(day, rule.plannedTime!, timeZone) > referenceInstant) return buildOccurrence(day, rule.plannedTime);
  }
  return null;
}

// Up to `limit` occurrences in a row after `reference` (optionally stopping at
// a date). Used by the forecast; never needs a database.
export function occurrencesAfter(
  rule: RuleConfig,
  reference: Point,
  options: { limit: number; until?: LocalDate | null; timeZone?: string },
): Occurrence[] {
  const timeZone = options.timeZone ?? RECURRENCE_TIME_ZONE;
  const result: Occurrence[] = [];
  let point = reference;
  while (result.length < options.limit) {
    const next = nextOccurrenceAfter(rule, point, timeZone);
    if (!next || (options.until && next.date > options.until)) break;
    result.push(next);
    point = { date: next.date, time: next.time };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

// The deadline of an instance planned on `plannedDate`, or null for none.
// Calendar days plus a wall-clock time: no elapsed-hours arithmetic, so a
// daylight saving change can never move it. `plannedDate` is the instance's
// actual planned date (for monthly series that is the already clamped one).
export function deadlineFor(rule: Pick<RuleConfig, "deadlineOffsetDays" | "deadlineTime">, plannedDate: LocalDate): { date: LocalDate; time: LocalTime | null } | null {
  if (rule.deadlineOffsetDays === null) return null;
  return { date: addDays(plannedDate, rule.deadlineOffsetDays), time: rule.deadlineTime };
}

// Rebuilds the offset from an existing task (used when converting a task).
export function deadlineOffsetFor(plannedDate: LocalDate, deadlineDate: LocalDate | null): number | null {
  if (deadlineDate === null) return null;
  return diffDays(deadlineDate, plannedDate);
}
