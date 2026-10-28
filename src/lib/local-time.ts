// Helpers for the user's local calendar dates ("2026-10-30") and wall-clock
// times ("14:00"). Tasks store these exactly as the user entered them; the
// user's IANA time zone decides what "now" is when they are compared.

export const DEFAULT_TIME_ZONE = "Europe/Tallinn";

export type LocalDate = string; // YYYY-MM-DD
export type LocalTime = string; // HH:MM, 24-hour

export type LocalNow = {
  date: LocalDate;
  time: LocalTime;
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// The current date and time as shown on a wall clock in the given time zone.
export function nowInTimeZone(timeZone: string, instant: Date = new Date()): LocalNow {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidLocalTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// PostgreSQL DATE and TIME columns arrive from Prisma as JavaScript Dates in UTC.
export function dateFromDb(value: Date | null): LocalDate | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function timeFromDb(value: Date | null): LocalTime | null {
  return value ? value.toISOString().slice(11, 16) : null;
}

export function dateToDb(value: LocalDate | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export function timeToDb(value: LocalTime | null): Date | null {
  return value ? new Date(`1970-01-01T${value}:00.000Z`) : null;
}

// "Fri, 30 Oct 2026". The date is formatted in UTC because it is already local.
export function formatLocalDate(value: LocalDate): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function formatLocalDateTime(date: LocalDate, time: LocalTime | null): string {
  return time ? `${formatLocalDate(date)}, ${time}` : formatLocalDate(date);
}

// A real moment in time (such as createdAt), shown in the user's time zone.
export function formatInstant(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
  }).format(new Date(value));
}
