import "server-only";

import { prisma } from "@/lib/db";
import { dateFromDb, dateToDb, formatLocalDate, nowInTimeZone } from "@/lib/local-time";
import { POSTPONE_MESSAGES, postponeProblem, type PostponeProblem } from "@/lib/postpone-rules";
import { idSchema } from "@/lib/recurrence/validation";
import { applyDeadlineChange } from "@/lib/task-rules";
import { ACTIVE_TASK } from "@/lib/task-state";

// "Postpone": moves a task's DEADLINE to a later day. It reuses the app's existing deadline rule
// (applyDeadlineChange), so the reschedule count and the original deadline are kept exactly as when
// the deadline is edited by hand, and everything that follows the deadline follows automatically:
// - Reminders belong to a deadline date. The old ones stop showing at once and the new date gets its
//   own (see src/lib/reminders/service.ts).
// - A repeating task: only THIS occurrence changes. Its occurrence key, the series rule, the series
//   version and all other tasks are untouched; the next occurrence is still created from the series rule.
//
// Safety: the user comes from the session (never the browser); only an active task of that user is
// found; and the update is one conditional statement that only succeeds if the deadline is still the
// one the user saw, so a stale page or a simultaneous request can never overwrite a newer change.

export type PostponeContext = { userId: string; timeZone: string; now?: Date };
export type PostponeInput = { taskId: string; newDate: string; expectedDeadlineDate: string };

export type PostponeCode = PostponeProblem | "NOT_FOUND" | "COMPLETED" | "NO_DEADLINE" | "STALE";
export type PostponeResult = { ok: true; deadlineDate: string; message: string } | { ok: false; code: PostponeCode; message: string };

const failure = (code: PostponeCode, message: string): PostponeResult => ({ ok: false, code, message });
const STALE = "This task was changed somewhere else. The page has been refreshed; please try again.";

export async function postponeTask(ctx: PostponeContext, input: PostponeInput): Promise<PostponeResult> {
  if (!idSchema.safeParse(input.taskId).success || typeof input.newDate !== "string") return failure("NOT_FOUND", "This task was not found.");
  const today = nowInTimeZone(ctx.timeZone, ctx.now).date;

  const task = await prisma.task.findFirst({ where: { id: input.taskId, userId: ctx.userId, ...ACTIVE_TASK } });
  if (!task) return failure("NOT_FOUND", "This task was not found.");
  if (task.status === "COMPLETED") return failure("COMPLETED", "A finished task cannot be postponed.");
  const current = dateFromDb(task.deadlineDate);
  if (current === null) return failure("NO_DEADLINE", "This task has no deadline to postpone.");
  if (input.expectedDeadlineDate !== current) return failure("STALE", STALE);

  const problem = postponeProblem(input.newDate, today, current);
  if (problem) return failure(problem, POSTPONE_MESSAGES[problem]);

  const deadline = applyDeadlineChange(
    { deadlineDate: current, originalDeadlineDate: dateFromDb(task.originalDeadlineDate), rescheduleCount: task.rescheduleCount },
    input.newDate,
  );
  // Only the date moves: the time of a timed deadline is kept, a date-only deadline stays date-only.
  const { count } = await prisma.task.updateMany({
    where: { id: task.id, userId: ctx.userId, ...ACTIVE_TASK, status: { not: "COMPLETED" }, deadlineDate: task.deadlineDate, rescheduleCount: task.rescheduleCount },
    data: {
      deadlineDate: dateToDb(input.newDate),
      status: "POSTPONED",
      originalDeadlineDate: dateToDb(deadline.originalDeadlineDate),
      rescheduleCount: deadline.rescheduleCount,
    },
  });
  if (count === 0) return failure("STALE", STALE);
  return { ok: true, deadlineDate: input.newDate, message: `Postponed to ${formatLocalDate(input.newDate)}.` };
}
