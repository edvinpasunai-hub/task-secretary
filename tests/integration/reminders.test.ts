// Stage 4.4: in-app reminders, against the separate test database.

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { completeTask } from "@/lib/recurrence/service";
import {
  getReminders,
  listReminders,
  markAllRemindersRead,
  markReminderRead,
  reconcileReminders,
  snoozeReminder,
} from "@/lib/reminders/service";

import { assertTestDatabase, at, createTask, createUser, ctxFor, newId, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring } from "../helpers/recurrence";

let userId: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser("me");
  other = await createUser("other");
});
afterAll(() => prisma.$disconnect());

const ctx = (date: string, time = "12:00", user = userId) => ({ userId: user, now: at(date, time) });
const rows = (user = userId) => prisma.reminder.findMany({ where: { userId: user }, orderBy: [{ scheduledAt: "asc" }, { type: "asc" }] });
const titles = async (c: ReturnType<typeof ctx>) => (await listReminders(c)).items.map((i) => i.title);

describe("creating reminders", () => {
  it("creates the day-before reminder for tomorrow's deadline and the due-day one for today's", async () => {
    await createTask(userId, { title: "Tomorrow", deadlineDate: "2026-11-11" });
    await createTask(userId, { title: "Today", deadlineDate: "2026-11-10" });
    expect(await reconcileReminders(ctx("2026-11-10", "10:00"))).toBe(2);
    const all = await prisma.reminder.findMany({ where: { userId }, include: { task: true } });
    expect(all.map((r) => `${r.task.title}:${r.type}`).sort()).toEqual(["Today:DUE_DAY", "Tomorrow:DAY_BEFORE"]);
    const today = all.find((r) => r.task.title === "Today")!;
    // 09:00 Tallinn in November = 07:00 UTC.
    expect(today.scheduledAt.toISOString()).toBe("2026-11-10T07:00:00.000Z");
    expect(today.forDueDate.toISOString().slice(0, 10)).toBe("2026-11-10");
  });

  it("creates nothing before 09:00, and everything that is due after it", async () => {
    await createTask(userId, { title: "Due", deadlineDate: "2026-11-10" });
    expect(await reconcileReminders(ctx("2026-11-10", "08:59"))).toBe(0);
    expect(await reconcileReminders(ctx("2026-11-10", "09:00"))).toBe(1);
  });

  it("creates reminders for a deadline that was missed while the app was closed (still today)", async () => {
    await createTask(userId, { title: "Due", deadlineDate: "2026-11-10" });
    // The app is first opened in the evening.
    expect(await reconcileReminders(ctx("2026-11-10", "21:00"))).toBe(1);
    expect(await titles(ctx("2026-11-10", "21:00"))).toEqual(["Due"]);
  });

  it("creates nothing for deadlines in the past, in the far future, without a deadline or when completed", async () => {
    await createTask(userId, { title: "Overdue", deadlineDate: "2026-11-09" });
    await createTask(userId, { title: "Long ago", deadlineDate: "2026-01-01" });
    await createTask(userId, { title: "Later", deadlineDate: "2026-11-20" });
    await createTask(userId, { title: "No deadline" });
    await createTask(userId, { title: "Done", deadlineDate: "2026-11-10", status: "COMPLETED" });
    expect(await reconcileReminders(ctx("2026-11-10", "12:00"))).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("a deadline set late (tomorrow, after 09:00) is reminded at once", async () => {
    await createTask(userId, { title: "Late", deadlineDate: "2026-11-11" });
    expect((await getReminders(ctx("2026-11-10", "15:00"))).items.map((i) => i.title)).toEqual(["Late"]);
  });

  it("uses the Tallinn day around midnight and on clock-change days", async () => {
    await createTask(userId, { title: "Spring", deadlineDate: "2026-03-29" });
    expect(await reconcileReminders({ userId, now: new Date("2026-03-29T05:59:00Z") })).toBe(0);
    expect(await reconcileReminders({ userId, now: new Date("2026-03-29T06:00:00Z") })).toBe(1);
    expect((await rows())[0].scheduledAt.toISOString()).toBe("2026-03-29T06:00:00.000Z");

    await createTask(userId, { title: "Autumn", deadlineDate: "2026-10-25" });
    expect(await reconcileReminders({ userId, now: new Date("2026-10-25T06:59:00Z") })).toBe(0);
    expect(await reconcileReminders({ userId, now: new Date("2026-10-25T07:00:00Z") })).toBe(1);
  });

  it("repeated and simultaneous loads create each reminder exactly once", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-11-10" });
    await createTask(userId, { title: "B", deadlineDate: "2026-11-11" });
    await Promise.all(Array.from({ length: 12 }, () => reconcileReminders(ctx("2026-11-10", "10:00"))));
    await reconcileReminders(ctx("2026-11-10", "10:05"));
    await getReminders(ctx("2026-11-10", "10:10"));
    expect(await rows()).toHaveLength(2);
  });

  it("a second reminder for the same task, type and deadline is refused by the database", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    await reconcileReminders(ctx("2026-11-10"));
    const existing = (await rows())[0];
    await expect(
      prisma.reminder.create({ data: { taskId: task.id, userId, type: existing.type, forDueDate: existing.forDueDate, scheduledAt: existing.scheduledAt } }),
    ).rejects.toThrow();
  });
});

describe("a new reminder is unread (manual-test regression)", () => {
  it("is created with readAt = NULL and no snooze, counted as 1 unread, and shown as unread", async () => {
    // The reported case: a normal task with a category named "daily", deadline 30 Oct 2026 09:00.
    const category = await prisma.category.create({ data: { id: newId("c"), userId, name: "daily", normalizedName: "daily", color: "TEAL" } });
    await createTask(userId, { title: "Test Reminder 4.4", deadlineDate: "2026-10-30", deadlineTime: "09:00", categoryId: category.id });

    const view = await getReminders(ctx("2026-10-29", "21:00"));
    const [row] = await rows();
    expect(row.type).toBe("DAY_BEFORE");
    expect(row.readAt).toBeNull();
    expect(row.snoozedUntil).toBeNull();
    expect(row.scheduledAt.toISOString()).toBe("2026-10-29T07:00:00.000Z"); // 09:00 Tallinn (winter time since 25 Oct)
    expect(view.unreadCount).toBe(1);
    expect(view.items.map((i) => [i.title, i.unread])).toEqual([["Test Reminder 4.4", true]]);
  });

  it("loading and listing again, and refreshing like an open panel, never mark anything as read", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-10-30" });
    for (const time of ["20:00", "21:00", "22:00", "23:00"]) {
      await getReminders(ctx("2026-10-29", time));
      await listReminders(ctx("2026-10-29", time));
    }
    const [row] = await rows();
    expect(row.readAt).toBeNull();
    expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime()); // never written to after creation
    expect((await listReminders(ctx("2026-10-29", "23:30"))).unreadCount).toBe(1);
  });

  it("only an explicit action marks it read", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-10-30" });
    const id = (await getReminders(ctx("2026-10-29", "21:00"))).items[0].id;
    await markReminderRead(ctx("2026-10-29", "21:05"), id);
    expect((await rows())[0].readAt).not.toBeNull();
    expect((await listReminders(ctx("2026-10-29", "21:06"))).unreadCount).toBe(0);
  });
});

describe("the list, read and snoozed reminders", () => {
  it("the due-day reminder replaces the day-before one, also while it is snoozed", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-11-11" });
    const before = await getReminders(ctx("2026-11-10", "10:00"));
    expect(before.items.map((i) => i.headline)).toEqual(["Due tomorrow"]);
    const due = (await getReminders(ctx("2026-11-11", "10:00"))).items;
    expect(due).toHaveLength(1);
    expect(due[0].unread).toBe(true);
    await snoozeReminder(ctx("2026-11-11", "10:00"), due[0].id);
    expect((await getReminders(ctx("2026-11-11", "11:00"))).items).toHaveLength(0);
    expect((await getReminders(ctx("2026-11-11", "14:00"))).items).toHaveLength(1);
  });

  it("shows due reminders with an unread count; reading removes it from the count only", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-11-10", deadlineTime: "14:00" });
    await createTask(userId, { title: "B", deadlineDate: "2026-11-11" });
    let view = await getReminders(ctx("2026-11-10", "10:00"));
    expect(view.unreadCount).toBe(2);
    expect(view.items.map((i) => [i.title, i.headline, i.unread])).toEqual(
      expect.arrayContaining([
        ["A", "Due today", true],
        ["B", "Due tomorrow", true],
      ]),
    );
    expect(view.items.find((i) => i.title === "A")!.deadline).toContain("14:00");

    expect(await markReminderRead(ctx("2026-11-10", "10:01"), view.items.find((i) => i.title === "A")!.id)).toBe(true);
    view = await listReminders(ctx("2026-11-10", "10:02"));
    expect(view.unreadCount).toBe(1);
    expect(view.items).toHaveLength(2); // the read one stays in the list
    expect(view.items.find((i) => i.title === "A")!.unread).toBe(false);
  });

  it("'Remind Later' hides it from the list and the badge for exactly 4 hours, then it is unread again", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-11-10" });
    const first = (await getReminders(ctx("2026-11-10", "10:00"))).items[0];
    await markReminderRead(ctx("2026-11-10", "10:00"), first.id); // read first, to show snoozing makes it unread
    expect(await snoozeReminder(ctx("2026-11-10", "10:00"), first.id)).toBe(true);

    for (const time of ["10:00", "12:00", "13:59"]) {
      const view = await getReminders(ctx("2026-11-10", time));
      expect(view.items, time).toHaveLength(0);
      expect(view.unreadCount, time).toBe(0);
    }
    const back = await getReminders(ctx("2026-11-10", "14:00"));
    expect(back.items.map((i) => [i.title, i.unread])).toEqual([["A", true]]);
    expect(back.unreadCount).toBe(1);
    // Snoozing did not create another reminder.
    expect(await rows()).toHaveLength(1);
  });

  it("a snoozed reminder cannot be read or snoozed again while it is hidden", async () => {
    await createTask(userId, { deadlineDate: "2026-11-10" });
    const id = (await getReminders(ctx("2026-11-10", "10:00"))).items[0].id;
    await snoozeReminder(ctx("2026-11-10", "10:00"), id);
    expect(await markReminderRead(ctx("2026-11-10", "11:00"), id)).toBe(false);
    expect(await snoozeReminder(ctx("2026-11-10", "11:00"), id)).toBe(false);
    expect((await rows())[0].snoozedUntil!.toISOString()).toBe(at("2026-11-10", "14:00").toISOString());
  });

  it("'mark all as read' marks what is shown and leaves snoozed reminders alone", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-11-10" });
    await createTask(userId, { title: "B", deadlineDate: "2026-11-11" });
    await createTask(userId, { title: "C", deadlineDate: "2026-11-10" });
    const view = await getReminders(ctx("2026-11-10", "10:00"));
    await snoozeReminder(ctx("2026-11-10", "10:00"), view.items.find((i) => i.title === "C")!.id);
    await markAllRemindersRead(ctx("2026-11-10", "10:05"));
    const after = await listReminders(ctx("2026-11-10", "10:06"));
    expect(after.unreadCount).toBe(0);
    expect(after.items.map((i) => i.title).sort()).toEqual(["A", "B"]);
    // When the snooze ends, C is still unread.
    const later = await listReminders(ctx("2026-11-10", "14:00"));
    expect(later.items.find((i) => i.title === "C")!.unread).toBe(true);
    expect(later.unreadCount).toBe(1);
  });

  it("reminders leave the list 7 days after they became due", async () => {
    await createTask(userId, { title: "A", deadlineDate: "2026-11-10" });
    await getReminders(ctx("2026-11-10", "10:00"));
    expect(await titles(ctx("2026-11-17", "08:00"))).toEqual(["A"]);
    expect(await titles(ctx("2026-11-17", "10:00"))).toEqual([]);
  });
});

describe("stale reminders", () => {
  it("changing the deadline hides the old reminders and the new date gets its own", async () => {
    const task = await createTask(userId, { title: "Move me", deadlineDate: "2026-11-10" });
    await getReminders(ctx("2026-11-10", "10:00"));
    expect(await titles(ctx("2026-11-10", "10:00"))).toEqual(["Move me"]);

    await prisma.task.update({ where: { id: task.id }, data: { deadlineDate: new Date("2026-11-12T00:00:00Z") } });
    expect((await getReminders(ctx("2026-11-10", "10:01"))).items).toHaveLength(0); // nothing for the 12th yet
    expect((await getReminders(ctx("2026-11-11", "10:00"))).items.map((i) => i.headline)).toEqual(["Due tomorrow"]);
    // On the deadline day the due-day reminder replaces the day-before one: one entry per task.
    expect((await getReminders(ctx("2026-11-12", "10:00"))).items.map((i) => i.headline)).toEqual(["Due today"]);
    expect(await prisma.reminder.count({ where: { taskId: task.id, forDueDate: new Date("2026-11-12T00:00:00Z") } })).toBe(2);
  });

  it("removing the deadline hides its reminders", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    await getReminders(ctx("2026-11-10", "10:00"));
    await prisma.task.update({ where: { id: task.id }, data: { deadlineDate: null, deadlineTime: null } });
    expect((await getReminders(ctx("2026-11-10", "10:01"))).items).toHaveLength(0);
  });

  it("moving the deadline back to the same date does not remind a second time", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    const id = (await getReminders(ctx("2026-11-10", "10:00"))).items[0].id;
    await markReminderRead(ctx("2026-11-10", "10:00"), id);
    await prisma.task.update({ where: { id: task.id }, data: { deadlineDate: new Date("2026-11-15T00:00:00Z") } });
    await getReminders(ctx("2026-11-10", "10:05"));
    await prisma.task.update({ where: { id: task.id }, data: { deadlineDate: new Date("2026-11-10T00:00:00Z") } });
    const view = await getReminders(ctx("2026-11-10", "10:10"));
    expect(view.items).toHaveLength(1);
    expect(view.items[0].unread).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("completing a task hides its reminders; reopening shows them again", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    await getReminders(ctx("2026-11-10", "10:00"));
    await prisma.task.update({ where: { id: task.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const hidden = await getReminders(ctx("2026-11-10", "11:00"));
    expect(hidden.items).toHaveLength(0);
    expect(hidden.unreadCount).toBe(0);
    await prisma.task.update({ where: { id: task.id }, data: { status: "TODO", completedAt: null } });
    expect((await getReminders(ctx("2026-11-10", "12:00"))).items).toHaveLength(1);
  });

  it("a task completed before its due moment never gets a reminder", async () => {
    await createTask(userId, { deadlineDate: "2026-11-11", status: "COMPLETED" });
    expect(await reconcileReminders(ctx("2026-11-11", "10:00"))).toBe(0);
  });

  it("postponed and in-progress tasks keep their reminders while the deadline is unchanged", async () => {
    await createTask(userId, { title: "P", deadlineDate: "2026-11-10", status: "POSTPONED" });
    await createTask(userId, { title: "I", deadlineDate: "2026-11-10", status: "IN_PROGRESS" });
    expect((await titles(ctx("2026-11-10", "10:00"))).length).toBe(0); // not reconciled yet: listing alone creates nothing
    expect((await getReminders(ctx("2026-11-10", "10:00"))).items.map((i) => i.title).sort()).toEqual(["I", "P"]);
  });

  it("a deleted task takes its reminders with it", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    await getReminders(ctx("2026-11-10", "10:00"));
    expect(await rows()).toHaveLength(1);
    await prisma.task.delete({ where: { id: task.id } });
    expect(await rows()).toHaveLength(0);
    expect((await getReminders(ctx("2026-11-10", "10:01"))).items).toHaveLength(0);
  });

  it("deleting a user deletes their reminders", async () => {
    await createTask(userId, { deadlineDate: "2026-11-10" });
    await getReminders(ctx("2026-11-10", "10:00"));
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.reminder.count()).toBe(0);
  });
});

describe("user isolation", () => {
  it("each user sees and counts only their own reminders", async () => {
    await createTask(userId, { title: "Mine", deadlineDate: "2026-11-10" });
    await createTask(other, { title: "Theirs", deadlineDate: "2026-11-10" });
    const mine = await getReminders(ctx("2026-11-10", "10:00"));
    const theirs = await getReminders(ctx("2026-11-10", "10:00", other));
    expect(mine.items.map((i) => i.title)).toEqual(["Mine"]);
    expect(theirs.items.map((i) => i.title)).toEqual(["Theirs"]);
    expect(mine.unreadCount).toBe(1);
  });

  it("another user's reminder cannot be read, snoozed or marked read in bulk", async () => {
    await createTask(userId, { deadlineDate: "2026-11-10" });
    const id = (await getReminders(ctx("2026-11-10", "10:00"))).items[0].id;
    const attacker = ctx("2026-11-10", "10:01", other);
    expect(await markReminderRead(attacker, id)).toBe(false);
    expect(await snoozeReminder(attacker, id)).toBe(false);
    await markAllRemindersRead(attacker);
    const row = (await rows())[0];
    expect(row.readAt).toBeNull();
    expect(row.snoozedUntil).toBeNull();
  });

  it("unknown ids change nothing", async () => {
    expect(await markReminderRead(ctx("2026-11-10"), newId("r"))).toBe(false);
    expect(await snoozeReminder(ctx("2026-11-10"), newId("r"))).toBe(false);
  });

  it("the database refuses a reminder whose owner is not the task's owner", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    await expect(
      prisma.reminder.create({
        data: { taskId: task.id, userId: other, type: "DUE_DAY", forDueDate: new Date("2026-11-10T00:00:00Z"), scheduledAt: at("2026-11-10", "09:00") },
      }),
    ).rejects.toThrow();
  });

  it("reconciling for one user does not create reminders for another", async () => {
    await createTask(other, { deadlineDate: "2026-11-10" });
    expect(await reconcileReminders(ctx("2026-11-10", "10:00"))).toBe(0);
    expect(await rows(other)).toHaveLength(0);
  });
});

describe("recurring tasks", () => {
  it("each instance has its own reminders; completing one hides its reminders and the successor gets its own later", async () => {
    // Weekly on Mondays; deadline two days after the planned date.
    const { task } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02", deadlineDate: "2026-11-04", title: "Weekly" });
    await getReminders(ctx("2026-11-04", "10:00"));
    expect((await listReminders(ctx("2026-11-04", "10:00"))).items.map((i) => i.taskId)).toEqual([task.id]);

    const done = await completeTask(ctxFor(userId, "2026-11-04", "11:00"), task.id);
    expect(done.ok).toBe(true);
    // The finished instance's reminders are hidden; the successor (deadline 2026-11-11) is not due yet.
    expect((await getReminders(ctx("2026-11-04", "11:01"))).items).toHaveLength(0);

    const next = await prisma.task.findFirstOrThrow({ where: { userId, status: { not: "COMPLETED" } } });
    expect(next.id).not.toBe(task.id);
    expect((await getReminders(ctx("2026-11-10", "10:00"))).items.map((i) => [i.taskId, i.headline])).toEqual([[next.id, "Due tomorrow"]]);
    expect((await getReminders(ctx("2026-11-11", "10:00"))).items.map((i) => i.headline)).toEqual(["Due today"]);
    expect(await prisma.reminder.count({ where: { taskId: next.id } })).toBe(2);
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(1);
  });

  it("a successor whose deadline is already past gets no historical reminders", async () => {
    const { task } = await makeRecurring(userId, { type: "DAILY", plannedDate: "2026-11-02", deadlineDate: "2026-11-02", title: "Daily" });
    // Completed late: the successor is created after "now", so its deadline is never in the past.
    await completeTask(ctxFor(userId, "2026-11-20", "12:00"), task.id);
    expect(await reconcileReminders(ctx("2026-11-20", "12:00"))).toBeLessThanOrEqual(2);
    for (const item of (await listReminders(ctx("2026-11-20", "12:00"))).items) {
      expect(item.taskId).not.toBe(task.id);
    }
  });

  it("stopping the series leaves the task's reminders in place", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02", deadlineDate: "2026-11-04", title: "Stopped" });
    await getReminders(ctx("2026-11-04", "10:00"));
    await prisma.recurringSeries.update({ where: { id: seriesId }, data: { state: "STOPPED" } });
    await prisma.task.update({ where: { id: task.id }, data: { seriesId: null, occurrenceKey: null } });
    expect((await listReminders(ctx("2026-11-04", "10:01"))).items).toHaveLength(1);
  });
});

describe("test database guard", () => {
  it("is running against a _test database", async () => {
    await assertTestDatabase();
  });
});
