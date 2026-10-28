import "server-only";

import type { Task } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { dateFromDb, timeFromDb } from "@/lib/local-time";
import { requireUser } from "@/lib/session";
import { taskIdSchema } from "@/lib/task-validation";

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
};

export function toTaskView(task: Task): TaskView {
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
  };
}

// Each function resolves the logged-in user itself, so callers cannot ask for
// another user's tasks.

// Most important first, then the earliest deadline (tasks without one last).
export async function getMyTasks(): Promise<TaskView[]> {
  const user = await requireUser();
  const tasks = await prisma.task.findMany({
    where: { userId: user.id },
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
// tell whether a task id belongs to someone else.
export async function getMyTask(id: string): Promise<TaskView | null> {
  const user = await requireUser();
  if (!taskIdSchema.safeParse(id).success) return null;
  const task = await prisma.task.findFirst({ where: { id, userId: user.id } });
  return task ? toTaskView(task) : null;
}
