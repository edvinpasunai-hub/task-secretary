import "server-only";

import type { TaskCategory } from "@/lib/category-rules";
import { prisma } from "@/lib/db";
import { logRecurrenceError } from "@/lib/recurrence/log";
import { requireUser } from "@/lib/session";
import { toTaskView, withCategory, type TaskView } from "@/lib/tasks";
import { daysLeft, purgeInstant, retentionCutoff } from "@/lib/trash/rules";
import { purgeExpiredTrash } from "@/lib/trash/service";

// What the Trash page shows for one task. The title is the owner's own data; nothing here
// carries the owner's id.
export type TrashItem = {
  id: string;
  title: string;
  status: TaskView["status"];
  category: TaskCategory | null;
  repeats: boolean;
  deletedAt: string;
  // The moment it is deleted for good, and the whole days left until then.
  purgeAt: string;
  daysLeft: number;
};

async function cleanUp(userId: string) {
  try {
    await purgeExpiredTrash({ userId });
  } catch (error) {
    logRecurrenceError("trash.purge_failed", { userId }, error);
  }
}

// The logged-in user's Trash: tasks deleted less than 30 days ago, newest first. Expired tasks
// are never listed, even if their physical cleanup has not happened yet; tombstones never are.
export async function getMyTrash(): Promise<TrashItem[]> {
  const user = await requireUser();
  await cleanUp(user.id);
  const now = new Date();
  const rows = await prisma.task.findMany({
    where: { userId: user.id, purgedAt: null, deletedAt: { gt: retentionCutoff(now) } },
    include: withCategory,
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
  });
  return rows.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    category: task.category,
    repeats: task.seriesId !== null,
    deletedAt: task.deletedAt!.toISOString(),
    purgeAt: purgeInstant(task.deletedAt!).toISOString(),
    daysLeft: daysLeft(task.deletedAt!, now),
  }));
}

// The logged-in user's archived tasks (finished tasks), most recently archived first.
export async function getMyArchive(): Promise<TaskView[]> {
  const user = await requireUser();
  await cleanUp(user.id);
  const rows = await prisma.task.findMany({
    where: { userId: user.id, deletedAt: null, archivedAt: { not: null } },
    include: withCategory,
    orderBy: [{ archivedAt: "desc" }, { id: "asc" }],
  });
  return rows.map(toTaskView);
}
