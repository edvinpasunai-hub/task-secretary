// The Repeat part of the task form, on the server: reading it, validating it, and
// turning what the user changed into a series patch. Pure functions.

import { z } from "zod";

import { isValidLocalDate, type LocalDate, type LocalTime } from "@/lib/local-time";
import { diffDays } from "@/lib/recurrence/civil-date";
import { RECURRENCE_TYPES, normalizeWeekdays, type RecurrenceTypeName, type RuleIssue } from "@/lib/recurrence/rules";
import type { RecurrenceError, SeriesView } from "@/lib/recurrence/types";
import type { SeriesPatch } from "@/lib/recurrence/validation";

export const REPEAT_FIELDS = ["repeatType", "repeatWeekdays", "repeatEndDate"] as const;
export type RepeatField = (typeof REPEAT_FIELDS)[number];

export type RepeatScope = "TASK" | "SERIES";

// What the form had, so it can be shown again after an error.
export type RepeatFormValues = { repeatType: string; repeatWeekdays: string[]; repeatEndDate: string; scope: RepeatScope };

export type RepeatChoice = { type: "NEVER" } | { type: RecurrenceTypeName; weekdays: number[]; endDate: LocalDate | null };

export type ParsedRepeat = {
  choice: RepeatChoice;
  scope: RepeatScope;
  // The series version the form was loaded with (only for tasks that already repeat).
  seriesVersion: number | null;
  values: RepeatFormValues;
  errors: Partial<Record<RepeatField, string>>;
};

const versionSchema = z.coerce.number().int().min(1).max(1_000_000);

export function parseRepeatForm(formData: FormData): ParsedRepeat {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const rawType = text("repeatType") || "NEVER";
  const rawWeekdays = formData.getAll("repeatWeekdays").filter((v): v is string => typeof v === "string");
  const rawEnd = text("repeatEndDate");
  const scope: RepeatScope = text("scope") === "SERIES" ? "SERIES" : "TASK";
  const version = versionSchema.safeParse(text("seriesVersion"));

  const values: RepeatFormValues = { repeatType: rawType, repeatWeekdays: rawWeekdays, repeatEndDate: rawEnd, scope };
  const result: ParsedRepeat = { choice: { type: "NEVER" }, scope, seriesVersion: version.success ? version.data : null, values, errors: {} };

  if (rawType === "NEVER") return result;
  if (!(RECURRENCE_TYPES as readonly string[]).includes(rawType)) {
    result.errors.repeatType = "Please choose how often the task repeats.";
    return result;
  }
  const type = rawType as RecurrenceTypeName;

  const weekdays = rawWeekdays.map(Number);
  if (type === "CUSTOM_WEEKDAYS") {
    if (weekdays.length === 0) result.errors.repeatWeekdays = "Please choose at least one weekday.";
    else if (!weekdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) result.errors.repeatWeekdays = "Please choose weekdays from the list.";
  }
  if (rawEnd !== "" && !isValidLocalDate(rawEnd)) result.errors.repeatEndDate = "Please enter a valid end date.";

  result.choice = { type, weekdays: type === "CUSTOM_WEEKDAYS" ? normalizeWeekdays(weekdays) : [], endDate: rawEnd === "" ? null : rawEnd };
  return result;
}

// Which form field a rule problem belongs to.
const ISSUE_FIELDS: Record<string, string> = {
  anchorDate: "plannedDate",
  plannedTime: "plannedTime",
  weekdays: "repeatWeekdays",
  monthlyDay: "repeatType",
  type: "repeatType",
  endDate: "repeatEndDate",
  deadlineOffsetDays: "deadlineDate",
  deadlineTime: "deadlineTime",
};

export function issueFieldErrors(issues: readonly RuleIssue[] | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues ?? []) {
    const field = ISSUE_FIELDS[issue.field];
    if (field) errors[field] ??= issue.message;
  }
  return errors;
}

// One calm sentence for every typed failure of the recurrence service.
export function recurrenceMessage(error: RecurrenceError): string {
  switch (error.code) {
    case "CONFLICT":
      return "This repeating task was changed somewhere else. Reload the page to see the latest version, then try again. Nothing was saved.";
    case "SERIES_STOPPED":
      return "Repeating was turned off for this task, so it can no longer be changed.";
    case "OCCURRENCE_CONFLICT":
      return "Another task in this series already has that date. Nothing was saved.";
    case "RECONCILE_FAILED":
      return "The series could not be brought up to date. Nothing was saved; please try again.";
    case "NOT_FOUND":
      return "This task was not found.";
    case "NOT_RECURRING":
      return "This task does not repeat.";
    case "ALREADY_RECURRING":
      return "This task already repeats.";
    case "INVALID_STATE":
      return error.message;
    case "VALIDATION":
      return error.message;
  }
}

// ---------------------------------------------------------------------------
// "This and future tasks": what changed in the form becomes the series patch.
// Only CHANGED fields are included, so saving never overwrites what other tasks
// of the series were given on purpose (for example by "Only this task" edits).
// ---------------------------------------------------------------------------

export type FormFields = {
  title: string;
  description: string | null;
  importance: "HIGH" | "NORMAL" | "LOW";
  estimatedMinutes: number | null;
  categoryId: string | null;
  plannedDate: LocalDate;
  plannedTime: LocalTime | null;
  deadlineDate: LocalDate | null;
  deadlineTime: LocalTime | null;
};

export type TaskAsLoaded = Omit<FormFields, "plannedDate"> & { plannedDate: LocalDate | null };

export function buildSeriesPatch(form: FormFields, task: TaskAsLoaded, series: Pick<SeriesView, "type" | "weekdays" | "endDate">, repeat: { type: RecurrenceTypeName; weekdays: number[]; endDate: LocalDate | null }): SeriesPatch {
  const patch: SeriesPatch = {};

  // template: only what this form changed
  if (form.title !== task.title) patch.title = form.title;
  if (form.description !== task.description) patch.description = form.description;
  if (form.importance !== task.importance) patch.importance = form.importance;
  if (form.estimatedMinutes !== task.estimatedMinutes) patch.estimatedMinutes = form.estimatedMinutes;
  if (form.categoryId !== task.categoryId) patch.categoryId = form.categoryId;

  // repeat rule
  const chosenWeekdays = normalizeWeekdays(repeat.weekdays);
  const sameWeekdays = JSON.stringify(normalizeWeekdays(series.weekdays)) === JSON.stringify(chosenWeekdays);
  if (repeat.type !== series.type || (repeat.type === "CUSTOM_WEEKDAYS" && !sameWeekdays)) {
    patch.type = repeat.type;
    if (repeat.type === "CUSTOM_WEEKDAYS") patch.weekdays = chosenWeekdays;
  }
  if (repeat.endDate !== series.endDate) patch.endDate = repeat.endDate;

  // time of day: add, change or remove
  if (form.plannedTime !== task.plannedTime) patch.plannedTime = form.plannedTime;

  // deadline rule: only when the DEADLINE fields were changed (moving just the planned
  // date postpones this task and leaves the rule alone)
  if (form.deadlineDate !== task.deadlineDate || form.deadlineTime !== task.deadlineTime) {
    patch.deadlineOffsetDays = form.deadlineDate ? diffDays(form.deadlineDate, form.plannedDate) : null;
    patch.deadlineTime = form.deadlineDate ? form.deadlineTime : null;
  }
  return patch;
}
