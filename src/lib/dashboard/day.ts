import { nowInTimeZone, type LocalDate } from "@/lib/local-time";
import { addDays } from "@/lib/recurrence/civil-date";
import { wallClockToInstant } from "@/lib/recurrence/zoned-time";

// The real-time span of one local calendar day: [start, end). The end is the start of the NEXT
// day, so a day that is 23 or 25 hours long (clock changes) is measured exactly, and a moment
// belongs to exactly one day.
export function localDayRange(date: LocalDate, timeZone: string): { start: Date; end: Date } {
  return {
    start: new Date(wallClockToInstant(date, "00:00", timeZone)),
    end: new Date(wallClockToInstant(addDays(date, 1), "00:00", timeZone)),
  };
}

// Today's local date and time for the user, and the span of that day.
export function todayRange(now: Date, timeZone: string) {
  const local = nowInTimeZone(timeZone, now);
  return { local, ...localDayRange(local.date, timeZone) };
}
