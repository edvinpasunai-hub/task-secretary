// Read-only projection of a series' FUTURE occurrences, for a later calendar
// view. Pure: it never touches a database, never creates tasks and has no
// effect on any counter.

import { addDays } from "@/lib/recurrence/civil-date";
import {
  compareOccurrenceKeys,
  occurrencesAfter,
  parseOccurrenceKey,
  RECURRENCE_TIME_ZONE,
  referencePoint,
  type Occurrence,
  type Point,
  type RuleConfig,
} from "@/lib/recurrence/rules";
import type { LocalDate, LocalNow } from "@/lib/local-time";

export type ForecastState = "ACTIVE" | "PAUSED" | "ENDED" | "STOPPED";

export const DEFAULT_FORECAST_LIMIT = 10;
export const MAX_FORECAST_LIMIT = 366;

export type ForecastInput = {
  rule: RuleConfig;
  state: ForecastState;
  pausedUntil: LocalDate | null;
  // Occurrence keys that already exist as tasks of this series.
  materializedKeys: readonly string[];
  now: LocalNow;
  limit?: number;
  // Inclusive last date to show.
  until?: LocalDate | null;
  timeZone?: string;
};

// The occurrences the rule would produce after the series' latest existing
// occurrence (or after now, if later), in order.
// - ENDED, STOPPED and indefinitely PAUSED series have no forecast;
// - a series PAUSED until a date forecasts from that date on;
// - the end date is respected; already existing occurrences are never repeated.
export function forecastOccurrences(input: ForecastInput): Occurrence[] {
  const { rule, state, pausedUntil, materializedKeys, now } = input;
  const timeZone = input.timeZone ?? RECURRENCE_TIME_ZONE;
  const limit = Math.max(0, Math.min(input.limit ?? DEFAULT_FORECAST_LIMIT, MAX_FORECAST_LIMIT));

  if (state === "ENDED" || state === "STOPPED" || limit === 0) return [];
  if (state === "PAUSED" && pausedUntil === null) return [];

  const latest = [...materializedKeys].sort(compareOccurrenceKeys).at(-1);
  let reference: Point = referencePoint(rule, latest ? parseOccurrenceKey(latest) : null, now, timeZone);

  // Paused until a date: nothing before that date is generated.
  if (state === "PAUSED" && pausedUntil !== null) {
    const lastPausedDay: Point = { date: addDays(pausedUntil, -1), time: rule.plannedTime === null ? null : "23:59" };
    if (lastPausedDay.date > reference.date) reference = lastPausedDay;
  }

  const taken = new Set(materializedKeys);
  return occurrencesAfter(rule, reference, { limit, until: input.until ?? null, timeZone }).filter((occurrence) => !taken.has(occurrence.key));
}
