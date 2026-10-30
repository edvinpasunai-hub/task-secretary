// Stage 4.5: Trash, Archive, permanent deletion and the 30-day cleanup, against the separate
// test database. Recurring tasks are covered separately in the "recurring" blocks.

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { completeTask, convertToRecurring, getSeries, pauseSeries, resumeSeries, updateSeries } from "@/lib/recurrence/service";
import { getReminders, listReminders, markReminderRead, reconcileReminders, snoozeReminder } from "@/lib/reminders/service";
import { TRASH_RETENTION_MS } from "@/lib/trash/rules";
import { archiveTask, deleteTaskForever, emptyTrash, purgeExpiredTrash, restoreTask, trashTask, trashTaskAndFuture, unarchiveTask } from "@/lib/trash/service";

import { at, createCategory, createTask, createUser, ctxFor, instancesOf, keysOf, newId, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring, seriesRow } from "../helpers/recurrence";

let userId: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser("me");
  other = await createUser("other");
});
afterAll(() => prisma.$disconnect());

const ctx = (date = "2026-11-02", time = "12:00", user = userId) => ctxFor(user, date, time);
const row = (id: string) => prisma.task.findUnique({ where: { id } });
const okValue = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.error)}`);
  return result.value as T;
};
const errorCode = (result: { ok: boolean; error?: { code: string } }) => (result.ok ? null : result.error!.code);
// A task that has been in Trash since `deletedAt`.
const trashedAt = (taskId: string, deletedAt: Date) => prisma.task.update({ where: { id: taskId }, data: { deletedAt } });
const days = (n: number) => n * 24 * 3600 * 1000;

describe("Trash and restore", () => {
  it("moves a task to Trash and back, idempotently", async () => {
    const task = await createTask(userId, { title: "Keep me" });
    expect(okValue(await trashTask(ctx(), task.id)).alreadyInTrash).toBe(false);
    expect((await row(task.id))!.deletedAt!.toISOString()).toBe(at("2026-11-02", "12:00").toISOString());
    expect(okValue(await trashTask(ctx("2026-11-03"), task.id)).alreadyInTrash).toBe(true); // repeated request
    expect((await row(task.id))!.deletedAt!.toISOString()).toBe(at("2026-11-02", "12:00").toISOString()); // the first time stays

    okValue(await restoreTask(ctx("2026-11-05"), task.id));
    const restored = (await row(task.id))!;
    expect(restored.deletedAt).toBeNull();
    expect(restored.title).toBe("Keep me");
    okValue(await restoreTask(ctx("2026-11-05"), task.id)); // repeating a restore is harmless
  });

  it("keeps everything about the task: category, status, dates, history", async () => {
    const category = await createCategory(userId, "Work");
    const task = await createTask(userId, { title: "T", categoryId: category.id, deadlineDate: "2026-12-01", status: "IN_PROGRESS", rescheduleCount: 2 });
    await trashTask(ctx(), task.id);
    await restoreTask(ctx(), task.id);
    const after = (await row(task.id))!;
    expect([after.categoryId, after.status, after.rescheduleCount]).toEqual([category.id, "IN_PROGRESS", 2]);
  });

  it("an archived task moved to Trash returns to the archive when restored", async () => {
    const task = await createTask(userId, { status: "COMPLETED" });
    okValue(await archiveTask(ctx(), task.id));
    await trashTask(ctx(), task.id);
    await restoreTask(ctx(), task.id);
    const after = (await row(task.id))!;
    expect([after.deletedAt, after.archivedAt === null]).toEqual([null, false]);
  });
});

describe("the 30-day boundary", () => {
  it("is restorable up to the last millisecond and refused from exactly 30 days on", async () => {
    const task = await createTask(userId);
    const deletedAt = at("2026-10-01", "10:00");
    await trashedAt(task.id, deletedAt);
    const boundary = new Date(deletedAt.getTime() + TRASH_RETENTION_MS);

    const tooLate = await restoreTask({ userId, now: boundary }, task.id);
    expect(errorCode(tooLate)).toBe("EXPIRED");
    expect((await row(task.id))!.deletedAt).not.toBeNull(); // still in Trash, not restored
    expect(errorCode(await restoreTask({ userId, now: new Date(boundary.getTime() + days(5)) }, task.id))).toBe("EXPIRED");

    okValue(await restoreTask({ userId, now: new Date(boundary.getTime() - 1) }, task.id));
    expect((await row(task.id))!.deletedAt).toBeNull();
  });

  it("an expired task cannot be restored even though it was never physically deleted", async () => {
    const task = await createTask(userId);
    await trashedAt(task.id, at("2026-09-01"));
    expect(await row(task.id)).not.toBeNull();
    expect(errorCode(await restoreTask(ctx("2026-11-02"), task.id))).toBe("EXPIRED");
    expect(await row(task.id)).not.toBeNull();
  });

  it("the cleanup deletes at exactly 30 days and not a millisecond earlier", async () => {
    const task = await createTask(userId);
    const deletedAt = at("2026-10-01", "10:00");
    await trashedAt(task.id, deletedAt);
    const boundary = new Date(deletedAt.getTime() + TRASH_RETENTION_MS);
    expect((await purgeExpiredTrash({ userId, now: new Date(boundary.getTime() - 1) })).removed).toBe(0);
    expect(await row(task.id)).not.toBeNull();
    expect((await purgeExpiredTrash({ userId, now: boundary })).removed).toBe(1);
    expect(await row(task.id)).toBeNull();
  });

  it("restore and cleanup at the same moment: exactly one of them wins, never both", async () => {
    const task = await createTask(userId);
    const deletedAt = at("2026-10-01", "10:00");
    await trashedAt(task.id, deletedAt);
    const boundary = new Date(deletedAt.getTime() + TRASH_RETENTION_MS);
    // Just before the boundary the restore wins; the cleanup (same clock) must not delete it.
    const before = new Date(boundary.getTime() - 1);
    const [restored, purged] = await Promise.all([restoreTask({ userId, now: before }, task.id), purgeExpiredTrash({ userId, now: before })]);
    expect(restored.ok).toBe(true);
    expect(purged.removed).toBe(0);
    expect((await row(task.id))!.deletedAt).toBeNull();
    // At the boundary the cleanup wins and the restore is refused.
    const task2 = await createTask(userId);
    await trashedAt(task2.id, deletedAt);
    const [r2, p2] = await Promise.all(Array.from({ length: 1 }, () => [restoreTask({ userId, now: boundary }, task2.id), purgeExpiredTrash({ userId, now: boundary })]).flat() as [ReturnType<typeof restoreTask>, ReturnType<typeof purgeExpiredTrash>]);
    expect(r2.ok).toBe(false);
    expect(p2.removed).toBe(1);
    expect(await row(task2.id)).toBeNull();
  });
});

describe("automatic cleanup", () => {
  it("deletes expired tasks and their reminders, and leaves the rest alone", async () => {
    const old = await createTask(userId, { title: "Old", deadlineDate: "2026-11-02" });
    const recent = await createTask(userId, { title: "Recent" });
    const active = await createTask(userId, { title: "Active" });
    await getReminders(ctx("2026-11-02", "10:00")); // creates the reminder for "Old"
    expect(await prisma.reminder.count({ where: { taskId: old.id } })).toBe(1);
    await trashedAt(old.id, at("2026-09-20"));
    await trashedAt(recent.id, at("2026-10-20"));

    expect((await purgeExpiredTrash(ctx("2026-11-02"))).removed).toBe(1);
    expect(await row(old.id)).toBeNull();
    expect(await prisma.reminder.count({ where: { taskId: old.id } })).toBe(0); // cascade
    expect(await row(recent.id)).not.toBeNull();
    expect(await row(active.id)).not.toBeNull();
  });

  it("is idempotent", async () => {
    const task = await createTask(userId);
    await trashedAt(task.id, at("2026-09-01"));
    expect((await purgeExpiredTrash(ctx())).removed).toBe(1);
    expect((await purgeExpiredTrash(ctx())).removed).toBe(0);
    expect((await purgeExpiredTrash(ctx())).removed).toBe(0);
  });

  it("is safe to run many times at once: every task is removed exactly once", async () => {
    for (let i = 0; i < 15; i++) await trashedAt((await createTask(userId, { title: `T${i}` })).id, at("2026-09-01"));
    const results = await Promise.all(Array.from({ length: 12 }, () => purgeExpiredTrash(ctx(), { batchSize: 4, maxBatches: 10 })));
    expect(results.reduce((sum, r) => sum + r.removed, 0)).toBe(15);
    expect(await prisma.task.count({ where: { userId } })).toBe(0);
  });

  it("works through a backlog bigger than one pass over repeated visits", async () => {
    for (let i = 0; i < 23; i++) await trashedAt((await createTask(userId, { title: `T${i}` })).id, new Date(at("2026-09-01").getTime() + i * 1000));
    const options = { batchSize: 5, maxBatches: 2 }; // at most 10 per visit
    expect((await purgeExpiredTrash(ctx(), options)).removed).toBe(10);
    expect(await prisma.task.count({ where: { userId } })).toBe(13);
    expect((await purgeExpiredTrash(ctx(), options)).removed).toBe(10);
    expect((await purgeExpiredTrash(ctx(), options)).removed).toBe(3);
    expect((await purgeExpiredTrash(ctx(), options)).removed).toBe(0);
    expect(await prisma.task.count({ where: { userId } })).toBe(0);
  });

  it("removes the oldest first, and the real defaults handle a normal backlog in one call", async () => {
    const a = await createTask(userId, { title: "older" });
    const b = await createTask(userId, { title: "newer" });
    await trashedAt(a.id, at("2026-08-01"));
    await trashedAt(b.id, at("2026-09-01"));
    await purgeExpiredTrash(ctx(), { batchSize: 1, maxBatches: 1 });
    expect(await row(a.id)).toBeNull();
    expect(await row(b.id)).not.toBeNull();
    expect((await purgeExpiredTrash(ctx())).removed).toBe(1);
  });

  it("only ever touches the given user's tasks", async () => {
    const mine = await createTask(userId);
    const theirs = await createTask(other);
    await trashedAt(mine.id, at("2026-09-01"));
    await trashedAt(theirs.id, at("2026-09-01"));
    expect((await purgeExpiredTrash(ctx())).removed).toBe(1);
    expect(await row(theirs.id)).not.toBeNull();
  });

  it("another user's bigger expired backlog never starves this user's cleanup", async () => {
    for (let i = 0; i < 5; i++) await trashedAt((await createTask(other, { title: `O${i}` })).id, new Date(at("2026-08-01").getTime() + i * 1000));
    const mine = await createTask(userId, { title: "mine" });
    await trashedAt(mine.id, at("2026-09-15"));
    expect((await purgeExpiredTrash(ctx(), { batchSize: 2, maxBatches: 2 })).removed).toBe(1);
    expect(await row(mine.id)).toBeNull();
    expect(await prisma.task.count({ where: { userId: other } })).toBe(5); // untouched
  });

  it("'Empty Trash' deletes everything in Trash for the user and nothing else", async () => {
    const a = await createTask(userId);
    const b = await createTask(userId);
    const keep = await createTask(userId);
    const theirs = await createTask(other);
    await trashTask(ctx(), a.id);
    await trashTask(ctx(), b.id);
    await trashTask(ctx("2026-11-02", "12:00", other), theirs.id);
    expect((await emptyTrash(ctx())).removed).toBe(2);
    expect([await row(a.id), await row(b.id)]).toEqual([null, null]);
    expect(await row(keep.id)).not.toBeNull();
    expect(await row(theirs.id)).not.toBeNull();
  });
});

describe("permanent deletion", () => {
  it("only a task that is in Trash can be deleted for good", async () => {
    const task = await createTask(userId);
    expect(errorCode(await deleteTaskForever(ctx(), task.id))).toBe("NOT_FOUND");
    await trashTask(ctx(), task.id);
    expect(okValue(await deleteTaskForever(ctx(), task.id)).kind).toBe("deleted");
    expect(await row(task.id)).toBeNull();
    expect(errorCode(await deleteTaskForever(ctx(), task.id))).toBe("NOT_FOUND"); // repeated
  });
});

describe("archive", () => {
  it("archives only completed tasks, idempotently, and restores them", async () => {
    const todo = await createTask(userId, { title: "todo" });
    const done = await createTask(userId, { title: "done", status: "COMPLETED" });
    expect(errorCode(await archiveTask(ctx(), todo.id))).toBe("NOT_COMPLETED");
    expect((await row(todo.id))!.archivedAt).toBeNull();

    okValue(await archiveTask(ctx(), done.id));
    const first = (await row(done.id))!.archivedAt!;
    okValue(await archiveTask(ctx("2026-11-09"), done.id)); // repeated
    expect((await row(done.id))!.archivedAt!.toISOString()).toBe(first.toISOString());
    expect((await row(done.id))!.status).toBe("COMPLETED"); // history intact

    okValue(await unarchiveTask(ctx(), done.id));
    expect((await row(done.id))!.archivedAt).toBeNull();
  });

  it("the database refuses an archived task that is not completed (Undo Complete cannot slip through)", async () => {
    const done = await createTask(userId, { status: "COMPLETED" });
    okValue(await archiveTask(ctx(), done.id));
    await expect(prisma.task.update({ where: { id: done.id }, data: { status: "TODO" } })).rejects.toThrow();
    await expect(prisma.task.update({ where: { id: (await createTask(userId)).id }, data: { archivedAt: new Date() } })).rejects.toThrow();
    // The normal order works: restore first, then reopen.
    await unarchiveTask(ctx(), done.id);
    await prisma.task.update({ where: { id: done.id }, data: { status: "TODO", completedAt: null } });
    expect((await row(done.id))!.status).toBe("TODO");
  });

  it("a trashed task cannot be archived", async () => {
    const done = await createTask(userId, { status: "COMPLETED" });
    await trashTask(ctx(), done.id);
    expect(errorCode(await archiveTask(ctx(), done.id))).toBe("NOT_FOUND");
  });
});

describe("user isolation", () => {
  it("another user cannot trash, restore, archive, un-archive or delete my task", async () => {
    const mine = await createTask(userId, { status: "COMPLETED" });
    const them = ctx("2026-11-02", "12:00", other);
    expect(errorCode(await trashTask(them, mine.id))).toBe("NOT_FOUND");
    expect(errorCode(await archiveTask(them, mine.id))).toBe("NOT_FOUND");
    await trashTask(ctx(), mine.id);
    expect(errorCode(await restoreTask(them, mine.id))).toBe("NOT_FOUND");
    expect(errorCode(await deleteTaskForever(them, mine.id))).toBe("NOT_FOUND");
    expect(errorCode(await unarchiveTask(them, mine.id))).toBe("NOT_FOUND");
    expect((await emptyTrash(them)).removed).toBe(0);
    expect((await row(mine.id))!.deletedAt).not.toBeNull();
  });

  it("malformed and unknown ids are refused", async () => {
    for (const id of ["", "x", "../etc", newId("t")]) {
      expect(errorCode(await trashTask(ctx(), id))).toBe("NOT_FOUND");
      expect(errorCode(await restoreTask(ctx(), id))).toBe("NOT_FOUND");
    }
  });
});

describe("reminders", () => {
  it("trashed and archived tasks neither get nor show reminders", async () => {
    const trashed = await createTask(userId, { title: "trashed", deadlineDate: "2026-11-02" });
    const archived = await createTask(userId, { title: "archived", deadlineDate: "2026-11-02", status: "COMPLETED" });
    const normal = await createTask(userId, { title: "normal", deadlineDate: "2026-11-02" });
    await trashTask(ctx(), trashed.id);
    await archiveTask(ctx(), archived.id);
    const view = await getReminders(ctx("2026-11-02", "10:00"));
    expect(view.items.map((i) => i.title)).toEqual(["normal"]);
    expect(await prisma.reminder.count({ where: { taskId: { in: [trashed.id, archived.id] } } })).toBe(0);
    expect(normal.id).toBeTruthy();
  });

  it("a task trashed after its reminder exists hides it at once; restore brings it back with its read state", async () => {
    const task = await createTask(userId, { title: "T", deadlineDate: "2026-11-02" });
    const id = (await getReminders(ctx("2026-11-02", "10:00"))).items[0].id;
    await markReminderRead(ctx("2026-11-02", "10:01"), id);
    await trashTask(ctx("2026-11-02", "10:02"), task.id);
    const hidden = await getReminders(ctx("2026-11-02", "10:03"));
    expect([hidden.items.length, hidden.unreadCount]).toEqual([0, 0]);
    expect(await markReminderRead(ctx("2026-11-02", "10:04"), id)).toBe(false); // cannot be changed while hidden
    expect(await snoozeReminder(ctx("2026-11-02", "10:04"), id)).toBe(false);

    await restoreTask(ctx("2026-11-02", "11:00"), task.id);
    const back = await getReminders(ctx("2026-11-02", "11:01"));
    expect(back.items.map((i) => [i.id, i.unread])).toEqual([[id, false]]); // same reminder, still read
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(1); // no duplicate
  });

  it("restoring keeps a snooze that is still running", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-02" });
    const id = (await getReminders(ctx("2026-11-02", "10:00"))).items[0].id;
    await snoozeReminder(ctx("2026-11-02", "10:00"), id);
    await trashTask(ctx("2026-11-02", "10:30"), task.id);
    await restoreTask(ctx("2026-11-02", "11:00"), task.id);
    expect((await getReminders(ctx("2026-11-02", "12:00"))).items).toHaveLength(0);
    expect((await getReminders(ctx("2026-11-02", "14:00"))).items.map((i) => i.unread)).toEqual([true]);
  });

  it("restoring does NOT bring back reminders for a deadline that has passed", async () => {
    const task = await createTask(userId, { title: "Past", deadlineDate: "2026-11-02" });
    await getReminders(ctx("2026-11-02", "10:00"));
    await trashTask(ctx("2026-11-02", "10:30"), task.id);
    // Restored three days after the deadline.
    await restoreTask(ctx("2026-11-05", "10:00"), task.id);
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(0);
    expect((await getReminders(ctx("2026-11-05", "10:01"))).items).toHaveLength(0);
    expect(await reconcileReminders(ctx("2026-11-05", "10:02"))).toBe(0); // and none is created for a past deadline
  });

  it("restoring a task with a future deadline gives normal reminders, without duplicates", async () => {
    const task = await createTask(userId, { title: "Future", deadlineDate: "2026-11-10" });
    await trashTask(ctx("2026-11-02"), task.id);
    await restoreTask(ctx("2026-11-03"), task.id);
    await Promise.all(Array.from({ length: 6 }, () => getReminders(ctx("2026-11-09", "10:00"))));
    expect((await listReminders(ctx("2026-11-09", "10:00"))).items.map((i) => i.headline)).toEqual(["Due tomorrow"]);
    await getReminders(ctx("2026-11-10", "10:00"));
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(2);
  });

  it("completing, reopening, archiving and restoring a task each update what the bell shows", async () => {
    const task = await createTask(userId, { title: "Cycle", deadlineDate: "2026-11-02" });
    const shown = async () => (await getReminders(ctx("2026-11-02", "10:00"))).items.length;
    expect(await shown()).toBe(1);
    await prisma.task.update({ where: { id: task.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    expect(await shown()).toBe(0);
    await archiveTask(ctx(), task.id);
    expect(await shown()).toBe(0);
    await unarchiveTask(ctx("2026-11-02", "10:00"), task.id);
    expect(await shown()).toBe(0); // still completed
    await prisma.task.update({ where: { id: task.id }, data: { status: "TODO", completedAt: null } }); // reopened
    expect(await shown()).toBe(1);
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(1);
  });
});

describe("recurring tasks: one occurrence", () => {
  it("trashing the tail of an active series skips it: the next occurrence is created and the series continues", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
    const outcome = okValue(await trashTask(ctx(), task.id));
    expect(outcome.successor?.occurrenceKey).toBe("2026-11-09");
    expect((await seriesRow(seriesId)).state).toBe("ACTIVE");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
    // Repeating the request creates nothing more.
    expect(okValue(await trashTask(ctx(), task.id)).alreadyInTrash).toBe(true);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
    // The successor is linked to the skipped occurrence and keeps the series going.
    const [skipped, next] = await instancesOf(seriesId);
    expect(next.predecessorId).toBe(skipped.id);
    await completeTask(ctx("2026-11-09"), next.id);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });

  it("trashing an instance that is not the tail creates nothing", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
    await completeTask(ctx("2026-11-02"), task.id); // creates 11-09 (the tail)
    const before = keysOf(await instancesOf(seriesId));
    okValue(await trashTask(ctx(), task.id));
    expect(keysOf(await instancesOf(seriesId))).toEqual(before);
  });

  it("restoring the skipped occurrence adds an ordinary unfinished task; nothing is duplicated or restarted", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
    await trashTask(ctx(), task.id);
    await restoreTask(ctx("2026-11-03"), task.id);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
    await completeTask(ctx("2026-11-03"), task.id); // not the tail: creates nothing
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("a paused series creates nothing when its tail is trashed, and resuming continues AFTER the skipped date", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
    const paused = okValue(await pauseSeries(ctx(), seriesId, 1, null));
    okValue(await trashTask(ctx(), task.id));
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02"]); // no successor while paused
    okValue(await resumeSeries(ctx("2026-11-03"), seriesId, paused.version));
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("when the end date has passed, trashing the last occurrence ends the series", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02", endDate: "2026-11-05" });
    okValue(await trashTask(ctx(), task.id));
    expect((await seriesRow(seriesId)).state).toBe("ENDED");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02"]);
  });

  it("a trashed task cannot be completed, edited or converted", async () => {
    const { task } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
    await trashTask(ctx(), task.id);
    expect(errorCode(await completeTask(ctx(), task.id))).toBe("NOT_FOUND");
    const ordinary = await createTask(userId);
    await trashTask(ctx(), ordinary.id);
    expect(errorCode(await convertToRecurring(ctx(), ordinary.id, { type: "DAILY" }))).toBe("NOT_FOUND");
  });

  it("trashing and completing the tail at the same time never duplicates an occurrence", async () => {
    for (let round = 0; round < 5; round++) {
      const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
      const results = await Promise.all([trashTask(ctx(), task.id), completeTask(ctx("2026-11-02"), task.id), trashTask(ctx(), task.id), completeTask(ctx("2026-11-02"), task.id)]);
      for (const r of results) expect(r.ok || errorCode(r) === "NOT_FOUND").toBe(true);
      const keys = keysOf(await instancesOf(seriesId));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(["2026-11-02", "2026-11-09"]); // exactly one successor
      await prisma.task.deleteMany({ where: { userId } });
      await prisma.recurringSeries.deleteMany({ where: { userId } });
    }
  });
});

describe("recurring tasks: this and future tasks", () => {
  async function threeInstances() {
    const first = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02", title: "Weekly" });
    await completeTask(ctx("2026-11-02"), first.task.id); // 11-02 done; 11-09 created
    const [, second] = await instancesOf(first.seriesId);
    await prisma.task.update({ where: { id: second.id }, data: { status: "IN_PROGRESS" } });
    return { ...first, second };
  }

  it("stops the series for good and moves the unfinished tasks to Trash; completed history stays", async () => {
    const { task, seriesId, second } = await threeInstances();
    const series = (await getSeries(ctx(), seriesId))!;
    const { trashed } = okValue(await trashTaskAndFuture(ctx(), second.id, series.version));
    expect(trashed).toBe(1);
    expect((await seriesRow(seriesId)).state).toBe("STOPPED");
    expect((await row(second.id))!.deletedAt).not.toBeNull();
    const done = (await row(task.id))!;
    expect([done.deletedAt, done.status]).toEqual([null, "COMPLETED"]);
  });

  it("requires the current series version, and refuses a series that is already stopped", async () => {
    const { seriesId, second } = await threeInstances();
    const stale = await trashTaskAndFuture(ctx(), second.id, 99);
    expect(errorCode(stale)).toBe("CONFLICT");
    expect((await seriesRow(seriesId)).state).toBe("ACTIVE"); // nothing changed
    expect((await row(second.id))!.deletedAt).toBeNull();
    const version = (await seriesRow(seriesId)).version;
    okValue(await trashTaskAndFuture(ctx(), second.id, version));
    expect(errorCode(await trashTaskAndFuture(ctx(), second.id, version + 1))).toBe("NOT_FOUND"); // task already in Trash
  });

  it("restoring a task of a stopped series does not restart the series", async () => {
    const { seriesId, second } = await threeInstances();
    okValue(await trashTaskAndFuture(ctx(), second.id, (await seriesRow(seriesId)).version));
    okValue(await restoreTask(ctx("2026-11-03"), second.id));
    expect((await seriesRow(seriesId)).state).toBe("STOPPED");
    const before = (await instancesOf(seriesId)).length;
    await completeTask(ctx("2026-11-09"), second.id);
    expect((await instancesOf(seriesId)).length).toBe(before); // completing creates nothing
    expect(errorCode(await pauseSeries(ctx(), seriesId, (await seriesRow(seriesId)).version))).toBe("SERIES_STOPPED");
    expect(errorCode(await resumeSeries(ctx(), seriesId, (await seriesRow(seriesId)).version))).toBe("SERIES_STOPPED");
    expect(errorCode(await updateSeries(ctx(), seriesId, (await seriesRow(seriesId)).version, { title: "X" }))).toBe("SERIES_STOPPED");
  });

  it("deleting the stopped series' tasks for good removes them and finally the empty series", async () => {
    const { task, seriesId, second } = await threeInstances();
    okValue(await trashTaskAndFuture(ctx(), second.id, (await seriesRow(seriesId)).version));
    okValue(await deleteTaskForever(ctx(), second.id));
    expect(await row(second.id)).toBeNull();
    expect(await prisma.recurringSeries.count({ where: { id: seriesId } })).toBe(1); // the completed task is still there
    await trashTask(ctx(), task.id); // explicit choice to delete the history too
    okValue(await deleteTaskForever(ctx(), task.id));
    expect(await prisma.recurringSeries.count({ where: { id: seriesId } })).toBe(0);
  });
});

describe("recurring tasks: permanent deletion never recreates an occurrence", () => {
  it("deleting the tail of a PAUSED series leaves a tombstone, and resuming continues after it", async () => {
    // The tail is in the future (16 Nov), now is 2 Nov: without the tombstone, resuming would create 16 Nov again.
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16", title: "Secret title", description: "Secret notes", deadlineDate: "2026-11-18" });
    const paused = okValue(await pauseSeries(ctx(), seriesId, 1, null));
    await getReminders(ctx("2026-11-17", "10:00")); // a reminder exists for the tail
    await trashTask(ctx("2026-11-17", "10:00"), task.id);
    expect(okValue(await deleteTaskForever(ctx("2026-11-17", "11:00"), task.id)).kind).toBe("tombstoned");

    const tomb = (await row(task.id))!;
    // Everything about the task is gone; only identifiers and the occurrence key remain.
    expect(tomb).toMatchObject({
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
      userId,
      seriesId,
      occurrenceKey: "2026-11-16",
    });
    expect(tomb.purgedAt).not.toBeNull();
    expect(tomb.deletedAt).not.toBeNull();
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(0);
    // The scrubbed row has no user-visible text anywhere.
    expect(JSON.stringify(tomb)).not.toMatch(/Secret/);

    okValue(await resumeSeries(ctx("2026-11-17", "12:00"), seriesId, paused.version));
    const keys = keysOf(await instancesOf(seriesId));
    expect(keys).toEqual(["2026-11-16", "2026-11-23"]); // 16 Nov is not created again; 23 Nov follows
    expect((await prisma.task.findMany({ where: { seriesId, purgedAt: null } })).map((t) => t.occurrenceKey)).toEqual(["2026-11-23"]);
  });

  it("an expired tail is turned into a tombstone by the automatic cleanup in the same way", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx(), seriesId, 1, null));
    await trashTask(ctx(), task.id);
    const later = ctx("2026-12-10"); // more than 30 days after 2 Nov
    expect((await purgeExpiredTrash(later)).removed).toBe(1);
    expect((await row(task.id))!.purgedAt).not.toBeNull();
    expect(errorCode(await restoreTask(later, task.id))).toBe("NOT_FOUND"); // a tombstone is not restorable
    expect((await purgeExpiredTrash(later)).removed).toBe(0); // and is not processed again
    expect(errorCode(await deleteTaskForever(later, task.id))).toBe("NOT_FOUND");
  });

  it("deleting a task that is not the tail removes the row, and the series is unaffected", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02" });
    await trashTask(ctx(), task.id); // skipped: 11-09 created and is now the tail
    expect(okValue(await deleteTaskForever(ctx(), task.id)).kind).toBe("deleted");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09"]);
    const [tail] = await instancesOf(seriesId);
    await completeTask(ctx("2026-11-09"), tail.id);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09", "2026-11-16"]); // 11-02 is never recreated
  });

  it("an old tombstone is dropped once a later instance exists", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    const paused = okValue(await pauseSeries(ctx(), seriesId, 1, null));
    await trashTask(ctx(), task.id);
    await deleteTaskForever(ctx(), task.id); // tombstone of 11-16
    okValue(await resumeSeries(ctx(), seriesId, paused.version)); // creates 11-23
    const [, next] = await instancesOf(seriesId);
    await trashTask(ctx(), next.id); // tail again: skipped, 11-30 created
    await deleteTaskForever(ctx(), next.id); // next is no longer the tail: hard delete -> tidies the old tombstone
    expect((await prisma.task.count({ where: { seriesId, purgedAt: { not: null } } }))).toBe(0);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-30"]);
  });

  it("deleting the same task from several places at once removes it exactly once", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx(), seriesId, 1, null));
    await trashTask(ctx(), task.id);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => deleteTaskForever(ctx(), task.id)),
      ...Array.from({ length: 5 }, () => restoreTask(ctx(), task.id)),
    ]);
    // Whatever order they ran in, the task is in one valid state: either restored (and deletes refused) or gone/tombstoned.
    const final = await row(task.id);
    if (final === null || final.purgedAt !== null) {
      expect(await prisma.task.count({ where: { seriesId, purgedAt: null } })).toBe(0);
    } else {
      expect(final.deletedAt).toBeNull();
    }
    expect(results.filter((r) => r.ok && "kind" in r.value).length).toBeLessThanOrEqual(1);
  });
});
