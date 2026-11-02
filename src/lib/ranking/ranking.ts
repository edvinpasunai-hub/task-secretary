// Stage 6.2: the deterministic task ranking engine. A PURE module: no database, no clock of its own (the
// caller passes the moment), no randomness, no persisted scores. The same tasks and the same moment always
// give exactly the same order, so it is easy to test and Stage 6.3 (Secretary's Focus) can simply consume it.
//
// Score of a task = priority points + due-date urgency points + (only for tasks WITHOUT a due date) age points.
//
//   Priority       HIGH +50   MEDIUM +25   LOW +0
//   Due date       overdue +60   due today +40   due tomorrow +25   due in 2-3 calendar days +15   later +0
//   Age (no due)   under 7 days +0   7-13 +5   14-29 +10   30-59 +15   60 or more +20
//
// - Only tasks that are active (not in Trash, not archived) and unfinished are ranked.
// - "Overdue" is the application's existing time-aware rule (the same one the Overdue badge and the dashboard
//   use): a timed deadline once its minute has passed, a date-only deadline after the end of its day.
// - Every "day" is a calendar day in the user's time zone (default Europe/Tallinn), never 24 elapsed hours, so the
//   23- and 25-hour days when the clocks change are handled exactly (same helpers as the dashboard).
// - Age counts calendar days since the task was CREATED (createdAt, which editing never changes).
// - Order: higher score, then the earlier due date (no due date last), then the higher priority, then the older
//   task, then the task id. That is a total order, so there are no unstable ties.

import type { Priority, TaskStatus } from "@/generated/prisma/enums";
import { classifyTask } from "@/lib/dashboard/sections";
import { DEFAULT_TIME_ZONE, nowInTimeZone, type LocalDate, type LocalNow, type LocalTime } from "@/lib/local-time";
import { diffDays } from "@/lib/recurrence/civil-date";

// ---------------------------------------------------------------------------------------------------------
// The scoring table (the only place the numbers live)
// ---------------------------------------------------------------------------------------------------------

export const PRIORITY_POINTS: Record<Priority, number> = { HIGH: 50, MEDIUM: 25, LOW: 0 };

export const URGENCY_LEVELS = ["OVERDUE", "TODAY", "TOMORROW", "SOON", "LATER", "NONE"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
// SOON = due in 2-3 calendar days; LATER = due after that; NONE = no due date (it gets age points instead).
export const URGENCY_POINTS: Record<UrgencyLevel, number> = { OVERDUE: 60, TODAY: 40, TOMORROW: 25, SOON: 15, LATER: 0, NONE: 0 };

// Highest band first: the first one whose minimum age is reached applies.
export const AGE_BANDS = [
  { minDays: 60, points: 20 },
  { minDays: 30, points: 15 },
  { minDays: 14, points: 10 },
  { minDays: 7, points: 5 },
] as const;

export const SOON_DAYS = 3; // "due in 2-3 calendar days" ends here

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

// What the ranking needs to know about a task. `createdAt` is an ISO instant; the due fields are the task's local
// wall-clock values (as everywhere in the app). deletedAt / archivedAt are only used to exclude a task.
export type RankableTask = {
  id: string;
  status: TaskStatus;
  priority: Priority;
  createdAt: string;
  deadlineDate: LocalDate | null;
  deadlineTime: LocalTime | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
};

export type RankingContext = {
  // The moment to rank at. The caller passes it, so results are reproducible.
  now: Date;
  // The user's IANA time zone. Defaults to Europe/Tallinn; an unknown zone falls back to it.
  timeZone?: string;
};

export type ScoreBreakdown = {
  priority: number;
  urgency: number;
  urgencyLevel: UrgencyLevel;
  age: number;
  // Calendar days since creation, or null when the task has a due date (age does not count for it).
  ageDays: number | null;
};

export type ScoredTask<T extends RankableTask = RankableTask> = { task: T; score: number; breakdown: ScoreBreakdown };
export type RankedTask<T extends RankableTask = RankableTask> = ScoredTask<T> & { rank: number };

// ---------------------------------------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------------------------------------

// Active, unfinished, not archived and not in Trash.
export function isRankable(task: Pick<RankableTask, "status" | "archivedAt" | "deletedAt">): boolean {
  return task.status !== "COMPLETED" && !task.archivedAt && !task.deletedAt;
}

// ---------------------------------------------------------------------------------------------------------
// Score parts
// ---------------------------------------------------------------------------------------------------------

export function urgencyLevel(task: Pick<RankableTask, "status" | "deadlineDate" | "deadlineTime">, now: LocalNow): UrgencyLevel {
  if (!task.deadlineDate) return "NONE";
  // The dashboard's classification decides "overdue" (time-aware), so the two always agree.
  if (classifyTask(task, now) === "overdue") return "OVERDUE";
  const days = diffDays(task.deadlineDate, now.date); // whole calendar days from today
  if (days <= 0) return "TODAY";
  if (days === 1) return "TOMORROW";
  if (days <= SOON_DAYS) return "SOON";
  return "LATER";
}

export function ageBonus(ageDays: number): number {
  for (const band of AGE_BANDS) if (ageDays >= band.minDays) return band.points;
  return 0;
}

// Calendar days from the day the task was created (in the user's time zone) to today. Never negative.
export function ageInDays(createdAt: string, now: LocalNow, timeZone: string): number {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(0, diffDays(now.date, nowInTimeZone(timeZone, created).date));
}

export function scoreTask<T extends RankableTask>(task: T, context: RankingContext): ScoredTask<T> {
  const timeZone = context.timeZone ?? DEFAULT_TIME_ZONE;
  const now = nowInTimeZone(timeZone, context.now);
  const level = urgencyLevel(task, now);
  const hasDue = level !== "NONE";
  const ageDays = hasDue ? null : ageInDays(task.createdAt, now, timeZone);
  const breakdown: ScoreBreakdown = {
    priority: PRIORITY_POINTS[task.priority],
    urgency: URGENCY_POINTS[level],
    urgencyLevel: level,
    age: ageDays === null ? 0 : ageBonus(ageDays),
    ageDays,
  };
  return { task, score: breakdown.priority + breakdown.urgency + breakdown.age, breakdown };
}

// ---------------------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------------------

const PRIORITY_ORDER: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// A date-only deadline lasts until the end of its day, so it sorts after the timed deadlines of that day
// (the same convention as the dashboard). Tasks without a due date have no key and sort last.
const dueKey = (task: Pick<RankableTask, "deadlineDate" | "deadlineTime">): string | null =>
  task.deadlineDate ? `${task.deadlineDate}T${task.deadlineTime ?? "23:59"}` : null;

const createdMs = (task: Pick<RankableTask, "createdAt">): number => {
  const ms = Date.parse(task.createdAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms; // an unreadable timestamp counts as the newest
};

// Negative when `a` ranks before `b`. A strict total order: it is 0 only for the very same task id.
export function compareScored(a: ScoredTask, b: ScoredTask): number {
  if (a.score !== b.score) return b.score - a.score; // 1. higher score first

  const dueA = dueKey(a.task);
  const dueB = dueKey(b.task);
  if (dueA !== dueB) {
    if (dueA === null) return 1; // 2. earlier due date first, no due date last
    if (dueB === null) return -1;
    return dueA < dueB ? -1 : 1;
  }

  const byPriority = PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority]; // 3. higher priority first
  if (byPriority !== 0) return byPriority;

  const ageA = createdMs(a.task);
  const ageB = createdMs(b.task);
  if (ageA !== ageB) return ageA < ageB ? -1 : 1; // 4. older task first

  if (a.task.id === b.task.id) return 0;
  return a.task.id < b.task.id ? -1 : 1; // 5. the task id as the last, stable tie-breaker
}

// ---------------------------------------------------------------------------------------------------------
// The ranking
// ---------------------------------------------------------------------------------------------------------

// Ranks the eligible tasks, best first. Pure: the input array and its tasks are not changed, and the same
// input always gives the same output. Ineligible tasks (finished, archived, in Trash) are simply left out.
export function rankTasks<T extends RankableTask>(tasks: readonly T[], context: RankingContext): Array<RankedTask<T>> {
  return tasks
    .filter(isRankable)
    .map((task) => scoreTask(task, context))
    .sort(compareScored)
    .map((scored, index) => ({ ...scored, rank: index + 1 }));
}
