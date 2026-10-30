// Which dashboard section a task belongs to, and how each section is sorted.
// Pure functions (no database), used by BOTH the dashboard and the Tasks page filters, so
// "View all" always shows exactly the tasks the dashboard counted.
//
// A task has one deadline (date, optionally a time); the planned date does not count as a due date.
//   overdue   the deadline has passed (the existing time-aware rule: isOverdue)
//   today     the deadline is today and has not passed yet
//   upcoming  the deadline is within the next 7 calendar days, not today
//   later     the deadline is more than 7 days away
//   none      no deadline
// Completed tasks belong to no section. Every unfinished task belongs to exactly one.

import type { Importance, TaskStatus } from "@/generated/prisma/enums";
import type { LocalDate, LocalNow, LocalTime } from "@/lib/local-time";
import { addDays } from "@/lib/recurrence/civil-date";
import { isOverdue } from "@/lib/task-rules";

export const DUE_SECTIONS = ["overdue", "today", "upcoming", "later", "none"] as const;
export type DueSection = (typeof DUE_SECTIONS)[number];

export const UPCOMING_DAYS = 7;

export const isDueSection = (value: unknown): value is DueSection => typeof value === "string" && (DUE_SECTIONS as readonly string[]).includes(value);

export const DUE_LABELS: Record<DueSection, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  later: "Later",
  none: "No due date",
};

export type ClassifiableTask = { status: TaskStatus; deadlineDate: LocalDate | null; deadlineTime: LocalTime | null };

export function classifyTask(task: ClassifiableTask, now: LocalNow): DueSection | null {
  if (task.status === "COMPLETED") return null;
  if (!task.deadlineDate) return "none";
  const timing = { status: task.status, plannedDate: null, plannedTime: null, deadlineDate: task.deadlineDate, deadlineTime: task.deadlineTime };
  if (isOverdue(timing, now) || task.deadlineDate < now.date) return "overdue";
  if (task.deadlineDate === now.date) return "today";
  if (task.deadlineDate <= addDays(now.date, UPCOMING_DAYS)) return "upcoming";
  return "later";
}

export type SortableTask = ClassifiableTask & { id: string; importance: Importance; createdAt: string };

const IMPORTANCE_RANK: Record<Importance, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };
// A date-only deadline lasts until the end of its day, so it sorts after timed deadlines of that day.
const dueKey = (task: ClassifiableTask) => `${task.deadlineDate}T${task.deadlineTime ?? "23:59"}`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Overdue, today and upcoming: the earliest deadline first, then the most important, then the oldest.
// No due date: the most important first, then the oldest.
export function compareInSection(section: DueSection) {
  return (a: SortableTask, b: SortableTask): number => {
    if (section !== "none") {
      const due = byText(dueKey(a), dueKey(b));
      if (due !== 0) return due;
    }
    return IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] || byText(a.createdAt, b.createdAt) || byText(a.id, b.id);
  };
}

// Every unfinished task in exactly one section, each section sorted.
export function partitionByDue<T extends SortableTask>(tasks: T[], now: LocalNow): Record<DueSection, T[]> {
  const sections: Record<DueSection, T[]> = { overdue: [], today: [], upcoming: [], later: [], none: [] };
  for (const task of tasks) {
    const section = classifyTask(task, now);
    if (section) sections[section].push(task);
  }
  for (const section of DUE_SECTIONS) sections[section].sort(compareInSection(section));
  return sections;
}
