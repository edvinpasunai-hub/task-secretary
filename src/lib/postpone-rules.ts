// The Postpone menu's dates and the rules a postponement must follow. Pure functions.
// "Today" is always the user's own calendar date (their saved time zone).

import { isValidLocalDate, type LocalDate } from "@/lib/local-time";
import { addDays, isoWeekday } from "@/lib/recurrence/civil-date";

export type PostponePreset = "tomorrow" | "in3days" | "nextWeek";

export const POSTPONE_LABELS: Record<PostponePreset, string> = {
  tomorrow: "Tomorrow",
  in3days: "In 3 days",
  nextWeek: "Next week",
};

// The next Monday after `today` (when today is a Monday, a week later).
export function nextMonday(today: LocalDate): LocalDate {
  return addDays(today, 8 - isoWeekday(today));
}

export function presetDate(choice: PostponePreset, today: LocalDate): LocalDate {
  if (choice === "tomorrow") return addDays(today, 1);
  if (choice === "in3days") return addDays(today, 3);
  return nextMonday(today);
}

export const MAX_POSTPONE_DAYS = 3650;

export type PostponeProblem = "INVALID_DATE" | "NOT_FUTURE" | "NOT_LATER" | "TOO_FAR";

// A postponement moves the deadline to a day that is both in the future (after today) and later
// than the current deadline. Anything else is refused.
export function postponeProblem(newDate: string, today: LocalDate, currentDeadline: LocalDate): PostponeProblem | null {
  if (!isValidLocalDate(newDate)) return "INVALID_DATE";
  if (newDate <= today) return "NOT_FUTURE";
  if (newDate <= currentDeadline) return "NOT_LATER";
  if (newDate > addDays(today, MAX_POSTPONE_DAYS)) return "TOO_FAR";
  return null;
}

export const POSTPONE_MESSAGES: Record<PostponeProblem, string> = {
  INVALID_DATE: "Please choose a valid date.",
  NOT_FUTURE: "Please choose a day after today.",
  NOT_LATER: "Please choose a day after the current deadline.",
  TOO_FAR: "That date is too far away.",
};

// The preset choices that really postpone this task (a preset that would not move the deadline
// later is not offered), and the range "Choose date" accepts.
export function postponeOptions(today: LocalDate, currentDeadline: LocalDate) {
  const options = (Object.keys(POSTPONE_LABELS) as PostponePreset[])
    .map((choice) => ({ choice, label: POSTPONE_LABELS[choice], date: presetDate(choice, today) }))
    .filter((option) => postponeProblem(option.date, today, currentDeadline) === null);
  const earliest = addDays(currentDeadline > today ? currentDeadline : today, 1);
  return { options, earliest, latest: addDays(today, MAX_POSTPONE_DAYS) };
}
