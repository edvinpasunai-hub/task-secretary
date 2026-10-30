// Task Secretary business rules. Pure functions with no database access, so
// the same rules run on the server and in the browser (for live form warnings).

import type { Priority, TaskStatus } from "@/generated/prisma/enums";
import type { LocalDate, LocalNow, LocalTime } from "@/lib/local-time";

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "POSTPONED", "COMPLETED"] as const satisfies readonly TaskStatus[];
export const PRIORITY_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const satisfies readonly Priority[];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  POSTPONED: "Postponed",
  COMPLETED: "Completed",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export const MAX_ESTIMATED_MINUTES = 168 * 60; // one week

export type TaskTiming = {
  status: TaskStatus;
  plannedDate: LocalDate | null;
  plannedTime: LocalTime | null;
  deadlineDate: LocalDate | null;
  deadlineTime: LocalTime | null;
};

// Comparable "YYYY-MM-DDTHH:MM" keys. A value without a time covers the whole
// day: it starts at 00:00 and ends at 23:59.
const startOf = (date: LocalDate, time: LocalTime | null) => `${date}T${time ?? "00:00"}`;
const endOf = (date: LocalDate, time: LocalTime | null) => `${date}T${time ?? "23:59"}`;
const nowKey = (now: LocalNow) => `${now.date}T${now.time}`;

// The deadline has passed and the task is not completed.
export function isOverdue(task: TaskTiming, now: LocalNow): boolean {
  if (task.status === "COMPLETED" || !task.deadlineDate) return false;
  return endOf(task.deadlineDate, task.deadlineTime) < nowKey(now);
}

// The planned time has passed but work has not started. This is only a hint,
// never "overdue": missing a plan is not the same as missing a deadline.
export function isPlannedTimeMissed(task: TaskTiming, now: LocalNow): boolean {
  if (!task.plannedDate || (task.status !== "TODO" && task.status !== "POSTPONED")) return false;
  const planned = task.plannedTime ? startOf(task.plannedDate, task.plannedTime) : endOf(task.plannedDate, null);
  return planned < nowKey(now);
}

// Planning to start after the deadline is allowed, but worth a warning.
export function isPlannedAfterDeadline(task: Omit<TaskTiming, "status">): boolean {
  if (!task.plannedDate || !task.deadlineDate) return false;
  return startOf(task.plannedDate, task.plannedTime) > endOf(task.deadlineDate, task.deadlineTime);
}

// Deadline-change rules from the v1.0 requirements, based on the deadline date:
// - the first deadline date ever assigned is remembered and never changes;
// - changing or removing an existing deadline date counts as a reschedule;
// - assigning the very first deadline, or keeping the same date, does not.
// Changing only the time of day is not counted.
export function applyDeadlineChange(
  current: { deadlineDate: LocalDate | null; originalDeadlineDate: LocalDate | null; rescheduleCount: number },
  nextDeadlineDate: LocalDate | null,
): { originalDeadlineDate: LocalDate | null; rescheduleCount: number } {
  const { deadlineDate, originalDeadlineDate, rescheduleCount } = current;
  if (nextDeadlineDate === deadlineDate) return { originalDeadlineDate, rescheduleCount };
  if (originalDeadlineDate === null) return { originalDeadlineDate: nextDeadlineDate, rescheduleCount };
  return { originalDeadlineDate, rescheduleCount: rescheduleCount + 1 };
}

// completedAt is set when a task becomes completed and cleared when it is reopened.
export function completedAtFor(current: { status: TaskStatus; completedAt: Date | null }, nextStatus: TaskStatus, now: Date) {
  if (nextStatus !== "COMPLETED") return null;
  return current.status === "COMPLETED" ? current.completedAt : now;
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
