import "server-only";

import type { Task } from "@/generated/prisma/client";
import type { TaskCategory } from "@/lib/category-rules";
import type { SeriesState } from "@/lib/recurrence/types";
import { prisma } from "@/lib/db";
import { dateFromDb, timeFromDb } from "@/lib/local-time";
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
  importance: Task["importance"];
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
    importance: task.importance,
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

// Most important first, then the earliest deadline (tasks without one last).
// With a category id, only that category's tasks (of every status). The
// owner filter always applies too, so another user's id can never match.
export async function getMyTasks(categoryId?: string): Promise<TaskView[]> {
  const user = await requireUser();
  // Repeating series whose "paused until" date has come are resumed here (there is
  // no background job). A cheap read when nothing is due. The list must still load
  // if this fails, but the failure is logged and the check simply runs again next time.
  try {
    await reconcileExpiredPauses({ userId: user.id });
  } catch (error) {
    logRecurrenceError("recurrence.reconcile_check_failed", { userId: user.id }, error);
  }
  // Reminders that have become due are created here too (no background job); a failure
  // is logged and never stops the list.
  try {
    await reconcileReminders({ userId: user.id });
  } catch (error) {
    logRecurrenceError("reminders.reconcile_failed", { userId: user.id }, error);
  }
  // Trash older than 30 days is deleted for good when the user uses the app; a failure is
  // logged and never stops the list (expired tasks are hidden and cannot be restored anyway).
  try {
    await purgeExpiredTrash({ userId: user.id });
  } catch (error) {
    logRecurrenceError("trash.purge_failed", { userId: user.id }, error);
  }
  const tasks = await prisma.task.findMany({
    where: { userId: user.id, ...ACTIVE_TASK, ...(categoryId && { categoryId }) },
    include: withCategory,
    orderBy: [
      { importance: "asc" },
      { deadlineDate: { sort: "asc", nulls: "last" } },
      { deadlineTime: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ],
  });
  return tasks.map(toTaskView);
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
