// Plain-English descriptions of a repeat rule, for the task form and task page.
// Pure functions, no database.

import { formatLocalDate, type LocalDate, type LocalTime } from "@/lib/local-time";
import { isoWeekday, parseCivil } from "@/lib/recurrence/civil-date";
import type { RecurrenceTypeName } from "@/lib/recurrence/rules";
import type { SeriesState } from "@/lib/recurrence/types";

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const REPEAT_LABELS: Record<RecurrenceTypeName | "NEVER", string> = {
  NEVER: "Never",
  DAILY: "Every day",
  WEEKLY: "Every week",
  MONTHLY: "Every month",
  CUSTOM_WEEKDAYS: "On chosen weekdays",
};

const ordinal = (n: number) => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

function joinWords(words: string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export type RepeatDescription = {
  type: RecurrenceTypeName;
  weekdays: readonly number[];
  monthlyDay: number | null;
  plannedTime: LocalTime | null;
  endDate: LocalDate | null;
};

// "Every day", "Every Monday at 09:00", "Every Monday, Wednesday and Friday",
// "On the 31st of every month (the last day in shorter months), until 14 Dec 2026".
export function describeRepeat(rule: RepeatDescription): string {
  let text: string;
  switch (rule.type) {
    case "DAILY":
      text = "Every day";
      break;
    case "WEEKLY":
      text = `Every ${WEEKDAY_NAMES[(rule.weekdays[0] ?? 1) - 1]}`;
      break;
    case "CUSTOM_WEEKDAYS":
      text = `Every ${joinWords([...rule.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d - 1]))}`;
      break;
    case "MONTHLY":
      text = `On the ${ordinal(rule.monthlyDay ?? 1)} of every month${(rule.monthlyDay ?? 1) > 28 ? " (the last day in shorter months)" : ""}`;
      break;
  }
  if (rule.plannedTime) text += ` at ${rule.plannedTime}`;
  if (rule.endDate) text += `, until ${formatLocalDate(rule.endDate)}`;
  return text;
}

// What the chosen repeat type means for a given planned date, shown live in the form.
export function describeChoice(type: RecurrenceTypeName | "NEVER", plannedDate: LocalDate | null, weekdays: readonly number[]): string {
  if (type === "NEVER") return "";
  if (!plannedDate) return "Choose a planned date: repeating tasks follow it.";
  switch (type) {
    case "DAILY":
      return "A new task appears every day.";
    case "WEEKLY":
      return `Repeats every ${WEEKDAY_NAMES[isoWeekday(plannedDate) - 1]}, like the planned date.`;
    case "MONTHLY": {
      const day = parseCivil(plannedDate).day;
      return `Repeats on the ${ordinal(day)} of every month${day > 28 ? ", or the last day of shorter months" : ""}.`;
    }
    case "CUSTOM_WEEKDAYS":
      return weekdays.length === 0 ? "Choose at least one weekday." : `Repeats every ${joinWords([...weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d - 1]))}.`;
  }
}

export function describeState(state: SeriesState, pausedUntil: LocalDate | null): string {
  switch (state) {
    case "ACTIVE":
      return "Active";
    case "PAUSED":
      return pausedUntil ? `Paused until ${formatLocalDate(pausedUntil)}` : "Paused";
    case "ENDED":
      return "Ended";
    case "STOPPED":
      return "Stopped";
  }
}
