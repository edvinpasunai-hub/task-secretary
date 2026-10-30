import "server-only";

import type { Task } from "@/generated/prisma/client";
import type { TaskCategory } from "@/lib/category-rules";
import type { SeriesState } from "@/lib/recurrence/types";
import { prisma } from "@/lib/db";
import { partitionByDue, type DueSection } from "@/lib/dashboard/sections";
import { dateFromDb, nowInTimeZone, timeFromDb } from "@/lib/local-time";
import { logRecurrenceError } from "@/lib/recurrence/log";
import { reconcileExpiredPauses } from "@/lib/recurrence/service";
import { reconcileReminders } from "@/lib/reminders/service";
import { requireUser } from "@/lib/session";
import { ACTIVE_TASK, VIEWABLE_TASK } from "@/lib/task-state";
import { taskIdSchema } from "@/lib/task-validation";
import { purgeExpiredTrash } from "@/lib/trash/service";

// What pages and components receive: plain values, never the owner's id.
export type TaskView = {
  id: string;
  title: string;
  description: string | null;
  priority: Task["priority"];
  status: Task["status"];
  plannedDate: string | null;
  plannedTime: string | null;
  deadlineDate: string | null;
  deadlineTime: string | null;
  originalDeadlineDate: string | null;
  rescheduleCount: number;
  estimatedMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  // Set for an archived task (view-only).
  archivedAt: string | null;
  // Only ever one of the owner's own categories.
  category: TaskCategory | null;
  // The series this task belongs to, if it repeats.
  seriesId: string | null;
  repeat: { state: SeriesState } | null;
};

// The task row together with its category, as loaded by the queries below.
type TaskWithCategory = Task & { category: TaskCategory | null; series: { state: SeriesState } | null };

export const withCategory = {
  category: { select: { id: true, name: true, color: true } },
  series: { select: { state: true } },
} as const;

export function toTaskView(task: TaskWithCategory): TaskView {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    plannedDate: dateFromDb(task.plannedDate),
    plannedTime: timeFromDb(task.plannedTime),
    deadlineDate: dateFromDb(task.deadlineDate),
    deadlineTime: timeFromDb(task.deadlineTime),
    originalDeadlineDate: dateFromDb(task.originalDeadlineDate),
    rescheduleCount: task.rescheduleCount,
    estimatedMinutes: task.estimatedMinutes,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    category: task.category,
    seriesId: task.seriesId,
    repeat: task.series ? { state: task.series.state } : null,
  };
}

// Each function resolves the logged-in user itself, so callers cannot ask for
// another user's tasks.

// What has to be brought up to date when the user opens a page that lists tasks. There is no
// background job: these run when the app is used. Each step may fail without stopping the page;
// the failure is logged and the step simply runs again next time.
// - Repeating series whose "paused until" date has come are resumed.
// - Reminders that have become due are created.
// - Trash older than 30 days is deleted for good (expired tasks are hidden and cannot be restored anyway).
export async function runListMaintenance(userId: string): Promise<void> {
  try {
    await reconcileExpiredPauses({ userId });
  } catch (error) {
    logRecurrenceError("recurrence.reconcile_check_failed", { userId }, error);
  }
  try {
    await reconcileReminders({ userId });
  } catch (error) {
    logRecurrenceError("reminders.reconcile_failed", { userId }, error);
  }
  try {
    await purgeExpiredTrash({ userId });
  } catch (error) {
    logRecurrenceError("trash.purge_failed", { userId }, error);
  }
}

// Most important first, then the earliest deadline (tasks without one last).
// With a category id, only that category's tasks (of every status). The
// owner filter always applies too, so another user's id can never match.
// With a due filter, only the unfinished tasks of that dashboard section, in the dashboard's order
// (the same rules as the dashboard, so "View all" matches what it counted).
export async function getMyTasks(categoryId?: string, due?: DueSection): Promise<TaskView[]> {
  const user = await requireUser();
  await runListMaintenance(user.id);
  const tasks = await prisma.task.findMany({
    where: { userId: user.id, ...ACTIVE_TASK, ...(categoryId && { categoryId }) },
    include: withCategory,
    orderBy: [
      { priority: "asc" },
      { deadlineDate: { sort: "asc", nulls: "last" } },
      { deadlineTime: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ],
  });
  const views = tasks.map(toTaskView);
  return due ? partitionByDue(views, nowInTimeZone(user.timeZone))[due] : views;
}

// Returns null both for unknown ids and for other users' tasks, so nobody can
// tell whether a task id belongs to someone else. A task in Trash cannot be opened (null);
// an archived one can, to be viewed.
export async function getMyTask(id: string): Promise<TaskView | null> {
  const user = await requireUser();
  if (!taskIdSchema.safeParse(id).success) return null;
  const task = await prisma.task.findFirst({ where: { id, userId: user.id, ...VIEWABLE_TASK }, include: withCategory });
  return task ? toTaskView(task) : null;
}
