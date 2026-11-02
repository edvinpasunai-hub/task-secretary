// Stage 6.2: the ranking engine against real data in the separate test database: who is eligible, that age
// comes from the ORIGINAL creation time (no edit resets it), time zones, repeating tasks, that ranking changes
// nothing, and that the existing dashboard and Tasks-page ordering is untouched.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: { id: "", name: "T", email: "t@example.invalid", timeZone: "Europe/Tallinn" } }));
vi.mock("@/lib/session", () => ({ requireUser: async () => session.user, getCurrentUser: async () => session.user }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));
vi.mock("next/cache", () => ({ refresh: () => undefined, revalidatePath: () => undefined }));

import { setTaskStatus, updateTask } from "@/app/tasks/actions";
import { loadDashboard } from "@/lib/dashboard/queries";
import { postponeTask } from "@/lib/postpone";
import { loadRankedTasks } from "@/lib/ranking/queries";
import { completeTask } from "@/lib/recurrence/service";
import { getMyTasks } from "@/lib/tasks";
import { archiveTask, deleteTaskForever, restoreTask, trashTask, unarchiveTask } from "@/lib/trash/service";

import { at, createTask, createUser, ctxFor, instancesOf, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring } from "../helpers/recurrence";

let me: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  me = await createUser("me");
  other = await createUser("other");
  session.user.id = me;
  session.user.timeZone = "Europe/Tallinn";
});
afterAll(() => prisma.$disconnect());

const NOW = at("2026-11-10", "14:30"); // Tuesday
const rank = (userId = me, now: Date = NOW, timeZone = "Europe/Tallinn") => loadRankedTasks({ userId, now, timeZone });
const ids = (ranked: Array<{ task: { id: string } }>) => ranked.map((r) => r.task.id);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ repeatType: "NEVER", ...fields })) data.set(key, value);
  return data;
};
const edit = (id: string, fields: Record<string, string>) => updateTask({}, form({ id, title: "A task", ...fields })).catch((error: Error) => {
  if (error.message !== "NEXT_REDIRECT") throw error; // saving redirects on success
});

describe("who is ranked", () => {
  it("only active, unfinished tasks: not finished, archived, in Trash, deleted tombstones, or someone else's", async () => {
    const todo = await createTask(me, { title: "todo" });
    const inProgress = await createTask(me, { title: "in progress", status: "IN_PROGRESS" });
    const postponed = await createTask(me, { title: "postponed", status: "POSTPONED" });
    await createTask(me, { title: "done", status: "COMPLETED", deadlineDate: "2026-11-01", priority: "HIGH" });
    const archived = await createTask(me, { title: "archived", status: "COMPLETED", deadlineDate: "2026-11-01", priority: "HIGH" });
    const trashed = await createTask(me, { title: "trashed", deadlineDate: "2026-11-01", priority: "HIGH" });
    await createTask(other, { title: "theirs", deadlineDate: "2026-11-01", priority: "HIGH" });
    await archiveTask(ctxFor(me), archived.id);
    await trashTask(ctxFor(me), trashed.id);

    expect(ids(await rank()).sort()).toEqual([todo.id, inProgress.id, postponed.id].sort());
  });

  it("a permanently deleted occurrence (tombstone) is never ranked", async () => {
    const { task, seriesId } = await makeRecurring(me, { type: "WEEKLY", plannedDate: "2026-11-16", deadlineDate: "2026-11-09", priority: "HIGH" });
    await prisma.recurringSeries.update({ where: { id: seriesId }, data: { state: "PAUSED" } });
    await trashTask(ctxFor(me), task.id);
    await deleteTaskForever(ctxFor(me), task.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).purgedAt).not.toBeNull();
    expect(await rank()).toEqual([]);
  });

  it("a task that is restored, un-archived or reopened is ranked again; one that is trashed or finished disappears", async () => {
    const task = await createTask(me, { title: "moving", priority: "HIGH", deadlineDate: "2026-11-10" });
    expect(ids(await rank())).toEqual([task.id]);
    await trashTask(ctxFor(me), task.id);
    expect(await rank()).toEqual([]);
    await restoreTask(ctxFor(me), task.id);
    expect(ids(await rank())).toEqual([task.id]);
    await prisma.task.update({ where: { id: task.id }, data: { status: "COMPLETED", completedAt: NOW } });
    expect(await rank()).toEqual([]);
    await archiveTask(ctxFor(me), task.id);
    expect(await rank()).toEqual([]);
    await unarchiveTask(ctxFor(me), task.id);
    await prisma.task.update({ where: { id: task.id }, data: { status: "TODO", completedAt: null } });
    expect(ids(await rank())).toEqual([task.id]);
  });
});

describe("scores from real rows", () => {
  it("ranks a realistic mix by the agreed points, with the breakdown", async () => {
    const overdueHigh = await createTask(me, { title: "overdue high", priority: "HIGH", deadlineDate: "2026-11-09" }); // 110
    const timedOverdue = await createTask(me, { title: "timed overdue", priority: "MEDIUM", deadlineDate: "2026-11-10", deadlineTime: "09:00" }); // 85
    const todayHigh = await createTask(me, { title: "today high", priority: "HIGH", deadlineDate: "2026-11-10", deadlineTime: "18:00" }); // 90
    const tomorrowMedium = await createTask(me, { title: "tomorrow medium", priority: "MEDIUM", deadlineDate: "2026-11-11" }); // 50
    const noDueHigh = await createTask(me, { title: "no due high", priority: "HIGH", createdAt: daysAgo(1) }); // 50
    const soonLow = await createTask(me, { title: "soon low", priority: "LOW", deadlineDate: "2026-11-13" }); // 15
    const agedNoDue = await createTask(me, { title: "aged no due", priority: "LOW", createdAt: daysAgo(75) }); // 20
    const laterLow = await createTask(me, { title: "later low", priority: "LOW", deadlineDate: "2026-12-30" }); // 0

    const ranked = await rank();
    expect(ranked.map((r) => [r.task.id, r.score, r.rank])).toEqual([
      [overdueHigh.id, 110, 1],
      [todayHigh.id, 90, 2],
      [timedOverdue.id, 85, 3],
      [tomorrowMedium.id, 50, 4], // ties with "no due high" (50): the task with a due date comes first
      [noDueHigh.id, 50, 5],
      [agedNoDue.id, 20, 6],
      [soonLow.id, 15, 7],
      [laterLow.id, 0, 8],
    ]);
    expect(ranked[0].breakdown).toMatchObject({ priority: 50, urgency: 60, urgencyLevel: "OVERDUE", age: 0, ageDays: null });
    expect(ranked[5].breakdown).toMatchObject({ priority: 0, urgency: 0, urgencyLevel: "NONE", age: 20, ageDays: 75 });
  });

  it("the due time stored in the database is read as the user's wall-clock time", async () => {
    const task = await createTask(me, { priority: "LOW", deadlineDate: "2026-11-10", deadlineTime: "14:29" });
    expect((await rank(me, at("2026-11-10", "14:29")))[0].breakdown.urgencyLevel).toBe("TODAY");
    expect((await rank(me, at("2026-11-10", "14:30")))[0].breakdown.urgencyLevel).toBe("OVERDUE");
    expect(task.id).toBeTruthy();
  });

  it("uses the saved time zone of the user: the same rows, a different day", async () => {
    await createTask(me, { priority: "LOW", deadlineDate: "2026-11-11" });
    const moment = new Date("2026-11-10T22:30:00Z"); // 00:30 on the 11th in Tallinn, 17:30 on the 10th in New York
    expect((await rank(me, moment, "Europe/Tallinn"))[0].breakdown.urgencyLevel).toBe("TODAY");
    expect((await rank(me, moment, "America/New_York"))[0].breakdown.urgencyLevel).toBe("TOMORROW");
    const defaulted = await loadRankedTasks({ userId: me, now: moment });
    expect(defaulted[0].breakdown.urgencyLevel).toBe("TODAY"); // no zone given: Europe/Tallinn
  });

  it("handles the clock-change days with real rows", async () => {
    await createTask(me, { priority: "LOW", deadlineDate: "2026-03-30" });
    expect((await rank(me, new Date("2026-03-29T20:59:59Z")))[0].breakdown.urgencyLevel).toBe("TOMORROW"); // last second of the 23-hour day
    expect((await rank(me, new Date("2026-03-29T21:00:00Z")))[0].breakdown.urgencyLevel).toBe("TODAY");
    await prisma.task.deleteMany({ where: { userId: me } });
    await createTask(me, { priority: "LOW", deadlineDate: "2026-10-26" });
    expect((await rank(me, new Date("2026-10-25T21:59:59Z")))[0].breakdown.urgencyLevel).toBe("TOMORROW"); // last second of the 25-hour day
    expect((await rank(me, new Date("2026-10-25T22:00:00Z")))[0].breakdown.urgencyLevel).toBe("TODAY");
  });
});

describe("age comes from the original creation time: nothing resets it", () => {
  const ageOf = async (id: string) => (await rank()).find((r) => r.task.id === id)!.breakdown;

  it("editing the title, description and priority (the Edit form) does not reset the age; updatedAt does change", async () => {
    const task = await createTask(me, { title: "Old task", priority: "LOW", createdAt: daysAgo(45) });
    expect(await ageOf(task.id)).toMatchObject({ ageDays: 45, age: 15 });
    const before = await row(task.id);

    await edit(task.id, { title: "Old task, renamed", description: "now with notes", priority: "HIGH" });
    const after = await row(task.id);
    expect(after.title).toBe("Old task, renamed"); // the edit really happened
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime()); // but the creation time is untouched
    expect(await ageOf(task.id)).toMatchObject({ ageDays: 45, age: 15, priority: 50 });
  });

  it("changing the status, postponing, trashing, restoring, archiving and un-archiving never touch it", async () => {
    const task = await createTask(me, { title: "Journey", createdAt: daysAgo(70) });
    const createdAt = (await row(task.id)).createdAt.getTime();
    const data = new FormData();
    data.set("id", task.id);
    data.set("status", "IN_PROGRESS");
    await setTaskStatus(data);
    await trashTask(ctxFor(me), task.id);
    await restoreTask(ctxFor(me), task.id);
    expect((await row(task.id)).createdAt.getTime()).toBe(createdAt);
    expect(await ageOf(task.id)).toMatchObject({ ageDays: 70, age: 20 });

    const dated = await createTask(me, { title: "Dated", createdAt: daysAgo(40), deadlineDate: "2026-11-10" });
    await postponeTask({ userId: me, timeZone: "Europe/Tallinn", now: NOW }, { taskId: dated.id, newDate: "2026-11-20", expectedDeadlineDate: "2026-11-10" });
    expect((await row(dated.id)).createdAt.getTime()).toBe(dated.createdAt.getTime());

    const finished = await createTask(me, { title: "Finished", createdAt: daysAgo(40), status: "COMPLETED" });
    await archiveTask(ctxFor(me), finished.id);
    await unarchiveTask(ctxFor(me), finished.id);
    expect((await row(finished.id)).createdAt.getTime()).toBe(finished.createdAt.getTime());
  });

  it("giving a task a due date and later removing it brings the same age back (the age was never reset)", async () => {
    const task = await createTask(me, { title: "Round trip", priority: "LOW", createdAt: daysAgo(20) });
    expect(await ageOf(task.id)).toMatchObject({ ageDays: 20, age: 10 });
    await edit(task.id, { priority: "LOW", deadlineDate: "2026-12-30" }); // gets a due date: age no longer counts
    expect(await ageOf(task.id)).toMatchObject({ age: 0, ageDays: null });
    await edit(task.id, { priority: "LOW", deadlineDate: "" }); // due date removed again
    expect(await ageOf(task.id)).toMatchObject({ ageDays: 20, age: 10 });
  });

  it("a new occurrence of a repeating task is a new task with its own age; each open occurrence is ranked on its own", async () => {
    const { task, seriesId } = await makeRecurring(me, { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM", createdAt: daysAgo(100) });
    await completeTask(ctxFor(me, "2026-11-02"), task.id);
    const [done, next] = await instancesOf(seriesId);
    expect(done.status).toBe("COMPLETED");
    expect(next.id).not.toBe(done.id);
    expect(next.createdAt.getTime()).toBeGreaterThan(done.createdAt.getTime()); // a new row, created when the previous one was completed
    await prisma.task.update({ where: { id: next.id }, data: { createdAt: daysAgo(3) } }); // (the test clock differs from the real one)
    const ranked = await rank();
    expect(ids(ranked)).toEqual([next.id]); // the finished occurrence is not ranked; the open one is, once
    // Its age starts from ITS own creation (3 days), not from the series' first task (100 days old, now finished).
    expect(ranked[0].breakdown).toMatchObject({ ageDays: 3, age: 0 });
  });
});

describe("ranking changes nothing and is not stored", () => {
  it("reading the ranking does not write to the database", async () => {
    await createTask(me, { priority: "HIGH", deadlineDate: "2026-11-09" });
    await createTask(me, { priority: "LOW", createdAt: daysAgo(90) });
    const snapshot = async () => JSON.stringify(await prisma.task.findMany({ orderBy: { id: "asc" } }));
    const before = await snapshot();
    await rank();
    await rank();
    expect(await snapshot()).toBe(before);
  });

  it("there is no score or rank column anywhere: nothing is persisted", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`select column_name from information_schema.columns where table_name in ('tasks','recurring_series') and (column_name ilike '%score%' or column_name ilike '%rank%')`;
    expect(columns).toEqual([]);
  });
});

describe("the existing pages are not affected", () => {
  it("the Tasks page keeps its own order (priority first, then the earliest deadline), which differs from the ranking", async () => {
    const overdueLow = await createTask(me, { title: "overdue low", priority: "LOW", deadlineDate: "2026-11-01" }); // ranked first (60)
    const highLater = await createTask(me, { title: "high later", priority: "HIGH", deadlineDate: "2026-12-30" }); // ranked second (50)
    const mediumNoDue = await createTask(me, { title: "medium no due", priority: "MEDIUM" });

    const tasksPage = (await getMyTasks()).map((t) => t.id);
    expect(tasksPage).toEqual([highLater.id, mediumNoDue.id, overdueLow.id]); // unchanged: by priority
    expect(ids(await rank())).toEqual([overdueLow.id, highLater.id, mediumNoDue.id]); // different: by score
  });

  it("the dashboard keeps its own sections and order (by due date, then priority), unchanged by the ranking", async () => {
    const a = await createTask(me, { title: "overdue older", priority: "LOW", deadlineDate: "2026-11-01" });
    const b = await createTask(me, { title: "overdue newer", priority: "HIGH", deadlineDate: "2026-11-09" });
    const data = await loadDashboard({ userId: me, name: null, timeZone: "Europe/Tallinn", now: NOW });
    expect(data.sections.overdue.map((t) => t.id)).toEqual([a.id, b.id]); // the earliest deadline first, as before
    expect(ids(await rank())).toEqual([b.id, a.id]); // the ranking puts the high-priority one first
  });
});
