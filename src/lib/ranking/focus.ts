// Stage 6.3: what Secretary's Focus shows for each recommended task. Pure functions (no database, no clock), built ONLY on
// the Stage 6.2 ranking result: the order and the score breakdown come from rankTasks; nothing is scored here.
//
// A FocusItem deliberately has no score: the numbers stay inside the ranking engine and are never displayed or sent to the
// page. The one-line reason is worked out by fixed rules from the task's real priority, its due-date level and its age
// (all in the breakdown), so it always matches the task: a task without a due date is never "overdue", a task due tomorrow
// is never "due today", and nothing is called urgent just because of its position.

import type { Priority } from "@/generated/prisma/enums";
import { formatLocalDate, type LocalDate, type LocalTime } from "@/lib/local-time";
import { diffDays } from "@/lib/recurrence/civil-date";
import type { RankableTask, RankedTask, UrgencyLevel } from "@/lib/ranking/ranking";

export const FOCUS_LIMIT = 5;

export const PRIORITY_NAMES: Record<Priority, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

// The age bands that are worth saying out loud (the same bands the ranking uses for its age bonus).
const WAITING_BANDS = [60, 30, 14, 7] as const;
const waitingFor = (ageDays: number): string | null => {
  const band = WAITING_BANDS.find((days) => ageDays >= days);
  return band === undefined ? null : `${band}+ days`;
};

export type ExplainInput = {
  priority: Priority;
  level: UrgencyLevel;
  // Calendar days since the task was created (only meaningful, and only given, for a task without a due date).
  ageDays: number | null;
  // Calendar days from today to the due date (for a task due in 2 or more days).
  daysUntilDue: number | null;
};

// One short line saying why the task is recommended.
export function explainRecommendation({ priority, level, ageDays, daysUntilDue }: ExplainInput): string {
  const high = priority === "HIGH";
  const name = `${PRIORITY_NAMES[priority]} priority`;
  switch (level) {
    case "OVERDUE":
      return high ? "High priority and overdue" : "Overdue and needs attention";
    case "TODAY":
      return high ? "High priority and due today" : "Due today";
    case "TOMORROW":
      return high ? "High priority, due tomorrow" : "Due tomorrow";
    case "SOON": {
      const when = `due in ${daysUntilDue ?? 2} days`;
      return high ? `High priority, ${when}` : `Due in ${daysUntilDue ?? 2} days`;
    }
    case "LATER":
      return `${name}, due in ${daysUntilDue ?? 4} days`;
    case "NONE": {
      const waiting = waitingFor(ageDays ?? 0);
      if (waiting) return high ? `High priority, waiting for ${waiting}` : `Waiting for ${waiting}`;
      return `${name}, no due date`;
    }
  }
}

// "Tue, 10 Nov" (the year only when it is not the current one).
function shortDate(date: LocalDate, today: LocalDate): string {
  const full = formatLocalDate(date);
  return date.slice(0, 4) === today.slice(0, 4) ? full.replace(/ \d{4}$/, "") : full;
}

// The due-date information shown on a row, in words.
export function dueLabel(task: Pick<RankableTask, "deadlineDate" | "deadlineTime">, level: UrgencyLevel, today: LocalDate): string {
  if (!task.deadlineDate) return "No due date";
  const time = (t: LocalTime | null) => (t ? `, ${t}` : "");
  switch (level) {
    case "OVERDUE":
      return `Overdue since ${shortDate(task.deadlineDate, today)}${time(task.deadlineTime)}`;
    case "TODAY":
      return `Due today${time(task.deadlineTime)}`;
    case "TOMORROW":
      return `Due tomorrow${time(task.deadlineTime)}`;
    default:
      return `Due ${shortDate(task.deadlineDate, today)}${time(task.deadlineTime)}`;
  }
}

export type FocusItem = {
  // 1 = the most recommended.
  rank: number;
  id: string;
  title: string;
  priority: Priority;
  priorityLabel: string; // "High" | "Medium" | "Low"
  dueLabel: string;
  reason: string;
};

type FocusTask = RankableTask & { title: string };

// The first `limit` ranked tasks as display rows. The order is exactly the ranking's; fewer rows when fewer tasks are
// eligible; no rows at all when none is.
export function toFocusItems(ranked: ReadonlyArray<RankedTask<FocusTask>>, today: LocalDate, limit: number = FOCUS_LIMIT): FocusItem[] {
  return ranked.slice(0, limit).map(({ task, rank, breakdown }) => ({
    rank,
    id: task.id,
    title: task.title,
    priority: task.priority,
    priorityLabel: PRIORITY_NAMES[task.priority],
    dueLabel: dueLabel(task, breakdown.urgencyLevel, today),
    reason: explainRecommendation({
      priority: task.priority,
      level: breakdown.urgencyLevel,
      ageDays: breakdown.ageDays,
      daysUntilDue: task.deadlineDate ? diffDays(task.deadlineDate, today) : null,
    }),
  }));
}
