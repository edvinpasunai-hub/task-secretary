import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { dateToDb, nowInTimeZone } from "@/lib/local-time";
import {
  abort,
  claimVersion,
  clock,
  ensureNext,
  latestInstance,
  localNowOf,
  lockSeries,
  loadSeries,
  reconcileForOperation,
  runTx,
} from "@/lib/recurrence/service";
import { fail, ok, type InstanceRef, type Result, type ServiceContext } from "@/lib/recurrence/types";
import { idSchema, versionSchema } from "@/lib/recurrence/validation";
import { REMINDER_TIME_ZONE } from "@/lib/reminders/rules";
import { PURGE_BATCH, PURGE_MAX_BATCHES, retentionCutoff } from "@/lib/trash/rules";

// Trash, archive and permanent deletion. Every function takes the user's id from the caller
// (the session, never the browser) and every query filters by it.
//
// Recurring tasks (how the guarantees are kept; see also docs/trash-archive.md):
// - Every operation on a task of a series first takes the series' advisory lock, the same lock
//   the recurrence engine uses, then makes CONDITIONAL updates (WHERE deletedAt IS NULL ...), so
//   concurrent or repeated requests change things once.
// - A task in Trash keeps its row and therefore its occurrence key: the unique key
//   (seriesId, occurrenceKey) makes that date impossible to generate again.
// - Moving the TAIL of an active series to Trash skips that occurrence: the engine's own
//   ensureNext creates the next one (a trashed tail counts as finished), exactly like completing it.
// - Restoring never touches the series. A stopped series is terminal and stays stopped.
// - Deleting for good removes the row, EXCEPT the tail of a series that could still generate
//   (active, paused or ended): that row is scrubbed into a "tombstone" that only keeps the
//   occurrence key, so the engine still sees the latest occurrence and never recreates it.
//   Tombstones are never listed, restored or shown, and an old one is dropped once a later
//   instance exists.

const idOk = (id: unknown): id is string => idSchema.safeParse(id).success;
const notFound = () => fail("NOT_FOUND", "This task was not found.");

// A restored or un-archived task must not bring back reminders for deadlines that have passed.
// Reminders for today or later keep their read/snooze state.
async function dropObsoleteReminders(db: Prisma.TransactionClient | typeof prisma, userId: string, taskId: string, now: Date) {
  const today = nowInTimeZone(REMINDER_TIME_ZONE, now).date;
  await db.reminder.deleteMany({ where: { taskId, userId, forDueDate: { lt: dateToDb(today)! } } });
}

// ---------------------------------------------------------------------------
// Move to Trash
// ---------------------------------------------------------------------------

export type TrashOutcome = { taskId: string; alreadyInTrash: boolean; successor: InstanceRef | null };

// One task (for a repeating one: this occurrence only; the series continues).
export async function trashTask(ctx: ServiceContext, taskId: string): Promise<Result<TrashOutcome>> {
  if (!idOk(taskId)) return notFound();
  return runTx(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, purgedAt: null }, select: { seriesId: true, deletedAt: true } });
    if (!task) return abort("NOT_FOUND", "This task was not found.");
    if (task.deletedAt) return { taskId, alreadyInTrash: true, successor: null };

    let series = null;
    if (task.seriesId) {
      await lockSeries(tx, task.seriesId);
      const loaded = await loadSeries(tx, ctx.userId, task.seriesId);
      if (loaded) series = (await reconcileForOperation(tx, ctx, loaded)).series;
    }
    const claim = await tx.task.updateMany({ where: { id: taskId, userId: ctx.userId, deletedAt: null, purgedAt: null }, data: { deletedAt: clock(ctx) } });
    if (claim.count === 0) return { taskId, alreadyInTrash: true, successor: null };

    // Skipping the occurrence: if it was the tail of an active series, the next one is created now.
    const successor = series && series.state === "ACTIVE" ? await ensureNext(tx, series, localNowOf(ctx)) : null;
    return { taskId, alreadyInTrash: false, successor };
  });
}

// "This and future tasks" of a repeating task: stops the series for good (version-checked) and
// moves every unfinished task of the series to Trash. Completed tasks stay where they are.
export async function trashTaskAndFuture(ctx: ServiceContext, taskId: string, expectedVersion: number): Promise<Result<{ trashed: number }>> {
  if (!idOk(taskId)) return notFound();
  if (!versionSchema.safeParse(expectedVersion).success) return fail("VALIDATION", "A version is required.");
  return runTx(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, deletedAt: null, purgedAt: null }, select: { seriesId: true } });
    if (!task) return abort("NOT_FOUND", "This task was not found.");
    if (!task.seriesId) return abort("NOT_RECURRING", "This task does not repeat.");
    await lockSeries(tx, task.seriesId);
    await claimVersion(tx, ctx, task.seriesId, expectedVersion, ["ACTIVE", "PAUSED", "ENDED"], { state: "STOPPED", pausedUntil: null });
    const { count } = await tx.task.updateMany({
      where: { seriesId: task.seriesId, userId: ctx.userId, deletedAt: null, purgedAt: null, status: { not: "COMPLETED" } },
      data: { deletedAt: clock(ctx) },
    });
    return { trashed: count };
  });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

// Brings a task back from Trash, if it has been there for less than 30 days. The age check is
// part of the update itself, so an expired task can never be restored, even if the cleanup has
// not run yet. The series (if any) is not touched.
export async function restoreTask(ctx: ServiceContext, taskId: string): Promise<Result<{ taskId: string }>> {
  if (!idOk(taskId)) return notFound();
  const now = clock(ctx);
  return runTx(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, purgedAt: null }, select: { seriesId: true, deletedAt: true } });
    if (!task) return abort("NOT_FOUND", "This task was not found.");
    if (!task.deletedAt) return { taskId }; // already active (a repeated request)
    if (task.seriesId) await lockSeries(tx, task.seriesId);

    const claim = await tx.task.updateMany({
      where: { id: taskId, userId: ctx.userId, purgedAt: null, deletedAt: { gt: retentionCutoff(now) } },
      data: { deletedAt: null },
    });
    if (claim.count === 0) {
      const again = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, purgedAt: null }, select: { deletedAt: true } });
      if (!again) return abort("NOT_FOUND", "This task was not found.");
      if (again.deletedAt) return abort("EXPIRED", "This task was in the Trash for more than 30 days and can no longer be restored.");
      return { taskId };
    }
    await dropObsoleteReminders(tx, ctx.userId, taskId, now);
    return { taskId };
  });
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

// Only finished tasks can be archived (the database checks it too).
export async function archiveTask(ctx: ServiceContext, taskId: string): Promise<Result<{ taskId: string }>> {
  if (!idOk(taskId)) return notFound();
  const claim = await prisma.task.updateMany({
    where: { id: taskId, userId: ctx.userId, deletedAt: null, archivedAt: null, purgedAt: null, status: "COMPLETED" },
    data: { archivedAt: clock(ctx) },
  });
  if (claim.count === 1) return ok({ taskId });
  const task = await prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId, deletedAt: null, purgedAt: null }, select: { status: true, archivedAt: true } });
  if (!task) return notFound();
  if (task.archivedAt) return ok({ taskId }); // already archived
  return fail("NOT_COMPLETED", "Only finished tasks can be archived.");
}

export async function unarchiveTask(ctx: ServiceContext, taskId: string): Promise<Result<{ taskId: string }>> {
  if (!idOk(taskId)) return notFound();
  const claim = await prisma.task.updateMany({
    where: { id: taskId, userId: ctx.userId, deletedAt: null, purgedAt: null, archivedAt: { not: null } },
    data: { archivedAt: null },
  });
  if (claim.count === 0) {
    const task = await prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId, deletedAt: null, purgedAt: null }, select: { id: true } });
    if (!task) return notFound();
  }
  await dropObsoleteReminders(prisma, ctx.userId, taskId, clock(ctx));
  return ok({ taskId });
}

// ---------------------------------------------------------------------------
// Permanent deletion
// ---------------------------------------------------------------------------

export type RemovalKind = "deleted" | "tombstoned" | "skipped";

// Physically removes one task that is in Trash. `expiredBy` (cleanup) additionally requires the
// task to be expired at that cutoff, so a task restored a moment earlier is never removed.
// Runs inside the caller's transaction, under the series lock for a repeating task.
async function removeInTx(tx: Prisma.TransactionClient, userId: string, taskId: string, now: Date, expiredBy?: Date): Promise<RemovalKind> {
  const where = { id: taskId, userId, purgedAt: null, deletedAt: expiredBy ? { not: null, lte: expiredBy } : { not: null } } satisfies Prisma.TaskWhereInput;
  const task = await tx.task.findFirst({ where, select: { seriesId: true } });
  if (!task) return "skipped";

  let kind: RemovalKind = "deleted";
  if (task.seriesId) {
    await lockSeries(tx, task.seriesId);
    if (!(await tx.task.findFirst({ where, select: { id: true } }))) return "skipped"; // changed while waiting for the lock
    const series = await loadSeries(tx, userId, task.seriesId);
    const tail = series && series.state !== "STOPPED" ? await latestInstance(tx, series.id) : null;
    if (tail && tail.id === taskId) kind = "tombstoned";
  }

  if (kind === "tombstoned") {
    // Scrub everything except the technical identifiers and the occurrence key (see the file header).
    await tx.reminder.deleteMany({ where: { taskId, userId } });
    const scrub = await tx.task.updateMany({
      where,
      data: {
        title: "",
        description: null,
        priority: "MEDIUM",
        status: "COMPLETED",
        plannedDate: null,
        plannedTime: null,
        deadlineDate: null,
        deadlineTime: null,
        originalDeadlineDate: null,
        rescheduleCount: 0,
        estimatedMinutes: null,
        completedAt: null,
        categoryId: null,
        archivedAt: null,
        predecessorId: null,
        purgedAt: now,
      },
    });
    if (scrub.count === 0) return "skipped";
  } else {
    // The reminders go with it (cascade).
    const removed = await tx.task.deleteMany({ where });
    if (removed.count === 0) return "skipped";
  }

  if (task.seriesId) await tidySeries(tx, userId, task.seriesId);
  return kind;
}

// After a removal: an older tombstone is no longer needed once a later instance exists, and a
// stopped series without any task left has nothing to keep.
async function tidySeries(tx: Prisma.TransactionClient, userId: string, seriesId: string) {
  const series = await loadSeries(tx, userId, seriesId);
  if (!series) return;
  const tail = await latestInstance(tx, seriesId);
  await tx.task.deleteMany({ where: { seriesId, userId, purgedAt: { not: null }, ...(tail ? { id: { not: tail.id } } : {}) } });
  if (series.state === "STOPPED" && (await tx.task.count({ where: { seriesId } })) === 0) {
    await tx.recurringSeries.deleteMany({ where: { id: seriesId, userId, state: "STOPPED" } });
  }
}

// "Delete permanently" on a task in Trash.
export async function deleteTaskForever(ctx: ServiceContext, taskId: string): Promise<Result<{ kind: RemovalKind }>> {
  if (!idOk(taskId)) return notFound();
  const result = await runTx(async (tx) => ({ kind: await removeInTx(tx, ctx.userId, taskId, clock(ctx)) }));
  if (result.ok && result.value.kind === "skipped") return notFound();
  return result;
}

// "Empty Trash": every task the user has in Trash (each in its own transaction).
export async function emptyTrash(ctx: ServiceContext): Promise<{ removed: number }> {
  let removed = 0;
  for (;;) {
    const ids = await prisma.task.findMany({
      where: { userId: ctx.userId, purgedAt: null, deletedAt: { not: null } },
      select: { id: true },
      orderBy: { deletedAt: "asc" },
      take: PURGE_BATCH,
    });
    if (ids.length === 0) return { removed };
    let progress = 0;
    for (const { id } of ids) {
      const result = await runTx(async (tx) => removeInTx(tx, ctx.userId, id, clock(ctx)));
      if (result.ok && result.value !== "skipped") progress++;
    }
    removed += progress;
    if (progress === 0) return { removed }; // nothing more can be removed right now
  }
}

// ---------------------------------------------------------------------------
// Automatic cleanup (no background job: runs when the user uses the app)
// ---------------------------------------------------------------------------

// Deletes the user's tasks that have been in Trash for 30 days or more, oldest first.
// - One pass removes up to PURGE_BATCH tasks and one call runs up to PURGE_MAX_BATCHES passes, so
//   a big backlog is cleared over a few visits at most; every call makes progress because
//   tombstones and tasks already handled no longer match the query.
// - Safe to repeat and to run at the same time: each task is removed by its own conditional
//   statement inside a transaction, so a second runner finds nothing left to do.
// - Only the given user's tasks are ever touched.
export async function purgeExpiredTrash(
  ctx: ServiceContext,
  { batchSize = PURGE_BATCH, maxBatches = PURGE_MAX_BATCHES }: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ removed: number }> {
  const now = clock(ctx);
  const cutoff = retentionCutoff(now);
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = await prisma.task.findMany({
      where: { userId: ctx.userId, purgedAt: null, deletedAt: { not: null, lte: cutoff } },
      select: { id: true },
      orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (ids.length === 0) break;
    for (const { id } of ids) {
      const result = await runTx(async (tx) => removeInTx(tx, ctx.userId, id, now, cutoff));
      if (result.ok && result.value !== "skipped") removed++;
    }
    if (ids.length < batchSize) break;
  }
  return { removed };
}
