import type { Importance } from "@/generated/prisma/enums";
import type { LocalDate, LocalTime } from "@/lib/local-time";
import type { RecurrenceTypeName, RuleIssue } from "@/lib/recurrence/rules";

// Expected problems come back as typed results so a future UI can show a clear
// message. Unexpected failures (database down, bugs) are thrown as errors.
export type RecurrenceErrorCode =
  | "NOT_FOUND" // unknown id, or someone else's: the two are indistinguishable on purpose
  | "CONFLICT" // the series changed since it was loaded (optimistic concurrency); see currentVersion
  | "VALIDATION" // the input is not acceptable; see issues
  | "OCCURRENCE_CONFLICT" // the change would give two instances the same scheduled occurrence
  | "INVALID_STATE" // the series is in a state where this is not possible
  | "SERIES_STOPPED" // recurrence was turned off; nothing can restart it
  | "ALREADY_RECURRING"
  | "NOT_RECURRING"
  | "RECONCILE_FAILED"; // an expired pause could not be reconciled, so the operation was not done

export type RecurrenceError = {
  code: RecurrenceErrorCode;
  message: string;
  // For CONFLICT: the version a refreshed form should use.
  currentVersion?: number;
  issues?: RuleIssue[];
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: RecurrenceError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: RecurrenceErrorCode, message: string, extra: Partial<RecurrenceError> = {}): Result<never> => ({
  ok: false,
  error: { code, message, ...extra },
});

// Thrown inside a transaction to roll everything back and return a typed result.
export class AbortWith extends Error {
  constructor(public readonly result: Result<never>) {
    super(result.ok ? "aborted" : result.error.message);
  }
}

// Who is asking, and what time it is. Tests pass a fixed `now`.
export type ServiceContext = { userId: string; now?: Date };

export type SeriesState = "ACTIVE" | "PAUSED" | "ENDED" | "STOPPED";

// What callers (and tests) see of a series: plain values, never the owner's id.
export type SeriesView = {
  id: string;
  type: RecurrenceTypeName;
  weekdays: number[];
  monthlyDay: number | null;
  anchorDate: LocalDate;
  plannedTime: LocalTime | null;
  title: string;
  description: string | null;
  importance: Importance;
  estimatedMinutes: number | null;
  categoryId: string | null;
  deadlineOffsetDays: number | null;
  deadlineTime: LocalTime | null;
  endDate: LocalDate | null;
  state: SeriesState;
  pausedUntil: LocalDate | null;
  version: number;
};

export type InstanceRef = { id: string; occurrenceKey: string };

// The fields of a task that a series is built from (what the task form saves).
export type NewTaskFields = {
  title: string;
  description: string | null;
  importance: Importance;
  categoryId: string | null;
  estimatedMinutes: number | null;
  plannedDate: LocalDate | null;
  plannedTime: LocalTime | null;
  deadlineDate: LocalDate | null;
  deadlineTime: LocalTime | null;
};
