import "server-only";

import { prisma } from "@/lib/db";
import { rankTasks, type RankedTask } from "@/lib/ranking/ranking";
import { ACTIVE_TASK } from "@/lib/task-state";
import { toTaskView, withCategory, type TaskView } from "@/lib/tasks";

// The ranked list of one user's tasks, ready for Stage 6.3 (Secretary's Focus) to consume. It is NOT used by any
// page yet: the dashboard and the Tasks page keep their own ordering, and nothing is stored.
//
// Takes the user from the caller (the session, never the browser) and reads only that user's tasks. Only active,
// unfinished tasks are loaded (not archived, not in Trash, and no tombstones); the ranking module then applies
// its own eligibility check as well, so the rule cannot be lost by changing one place.
export async function loadRankedTasks(ctx: { userId: string; timeZone?: string; now?: Date }): Promise<Array<RankedTask<TaskView>>> {
  const rows = await prisma.task.findMany({
    where: { userId: ctx.userId, ...ACTIVE_TASK, status: { not: "COMPLETED" } },
    include: withCategory,
  });
  return rankTasks(rows.map(toTaskView), { now: ctx.now ?? new Date(), timeZone: ctx.timeZone });
}
