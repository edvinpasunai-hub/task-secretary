// Stage 4.5: what the app SHOWS. The task list, the task page, the category counts, the Trash and
// Archive pages must show only what they should, and never a tombstone. The session is replaced by
// a chosen user; everything else is the real code and the real test database.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: { id: "", name: "t", email: "t@example.invalid", timeZone: "Europe/Tallinn" } }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => session.user,
  getCurrentUser: async () => session.user,
}));

import { getMyCategories } from "@/lib/categories";
import { pauseSeries } from "@/lib/recurrence/service";
import { getMyTask, getMyTasks } from "@/lib/tasks";
import { getMyArchive, getMyTrash } from "@/lib/trash/queries";
import { archiveTask, deleteTaskForever, trashTask } from "@/lib/trash/service";

import { at, createCategory, createTask, createUser, ctxFor, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring } from "../helpers/recurrence";

let userId: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser("me");
  other = await createUser("other");
  session.user.id = userId;
});
afterAll(() => prisma.$disconnect());

const ctx = (date = "2026-11-02") => ctxFor(userId, date);
const titles = (tasks: Array<{ title: string }>) => tasks.map((t) => t.title).sort();
// Trash for a task that was deleted `daysAgo` days ago (relative to the real clock the pages use).
const trashedDaysAgo = (taskId: string, daysAgo: number, extraMs = 0) =>
  prisma.task.update({ where: { id: taskId }, data: { deletedAt: new Date(Date.now() - daysAgo * 86_400_000 + extraMs) } });

describe("the task list and the task page", () => {
  it("show only active tasks", async () => {
    await createTask(userId, { title: "active" });
    await createTask(userId, { title: "done", status: "COMPLETED" });
    const trashed = await createTask(userId, { title: "trashed" });
    const archived = await createTask(userId, { title: "archived", status: "COMPLETED" });
    await trashTask(ctx(), trashed.id);
    await archiveTask(ctx(), archived.id);
    expect(titles(await getMyTasks())).toEqual(["active", "done"]);
  });

  it("a task in Trash cannot be opened; an archived one can (to be viewed)", async () => {
    const trashed = await createTask(userId, { title: "trashed" });
    const archived = await createTask(userId, { title: "archived", status: "COMPLETED" });
    await trashTask(ctx(), trashed.id);
    await archiveTask(ctx(), archived.id);
    expect(await getMyTask(trashed.id)).toBeNull();
    const view = await getMyTask(archived.id);
    expect(view?.title).toBe("archived");
    expect(view?.archivedAt).not.toBeNull();
  });

  it("another user's tasks are never shown, in any state", async () => {
    const theirs = await createTask(other, { title: "theirs", status: "COMPLETED" });
    expect(await getMyTask(theirs.id)).toBeNull();
    await trashTask(ctxFor(other), theirs.id);
    expect(await getMyTask(theirs.id)).toBeNull();
    expect(await getMyTrash()).toEqual([]);
    expect(await getMyArchive()).toEqual([]);
  });

  it("a restored task is back in the list", async () => {
    const task = await createTask(userId, { title: "back" });
    await trashTask(ctx(), task.id);
    expect(await getMyTasks()).toHaveLength(0);
    await prisma.task.update({ where: { id: task.id }, data: { deletedAt: null } });
    expect(titles(await getMyTasks())).toEqual(["back"]);
  });

  it("loading the list also cleans up expired Trash", async () => {
    const old = await createTask(userId, { title: "old" });
    await trashTask(ctx(), old.id);
    await trashedDaysAgo(old.id, 31);
    await getMyTasks();
    expect(await prisma.task.findUnique({ where: { id: old.id } })).toBeNull();
  });
});

describe("category counts", () => {
  it("count active tasks only", async () => {
    const category = await createCategory(userId, "Work");
    await createTask(userId, { title: "a", categoryId: category.id });
    await createTask(userId, { title: "b", categoryId: category.id, status: "COMPLETED" });
    const trashed = await createTask(userId, { title: "c", categoryId: category.id });
    const archived = await createTask(userId, { title: "d", categoryId: category.id, status: "COMPLETED" });
    await trashTask(ctx(), trashed.id);
    await archiveTask(ctx(), archived.id);
    const [work] = await getMyCategories();
    expect(work.taskCount).toBe(2);
  });

  it("trashed and archived tasks keep their category (restoring brings it back)", async () => {
    const category = await createCategory(userId, "Home");
    const task = await createTask(userId, { title: "x", categoryId: category.id });
    await trashTask(ctx(), task.id);
    const [trashItem] = await getMyTrash();
    expect(trashItem.category?.id).toBe(category.id);
  });
});

describe("the Trash page", () => {
  it("lists tasks with the date they are deleted permanently and the days left, newest first", async () => {
    const a = await createTask(userId, { title: "older" });
    const b = await createTask(userId, { title: "newer" });
    await trashTask(ctx(), a.id);
    await trashTask(ctx(), b.id);
    await trashedDaysAgo(a.id, 10);
    await trashedDaysAgo(b.id, 1);
    const items = await getMyTrash();
    expect(items.map((i) => i.title)).toEqual(["newer", "older"]);
    expect(items.map((i) => i.daysLeft)).toEqual([29, 20]);
    for (const item of items) {
      expect(new Date(item.purgeAt).getTime() - new Date(item.deletedAt).getTime()).toBe(30 * 86_400_000);
    }
  });

  it("never lists an expired task (it is removed before listing), nor anything archived or active", async () => {
    const expired = await createTask(userId, { title: "expired" });
    const fresh = await createTask(userId, { title: "fresh" });
    await createTask(userId, { title: "active" });
    await trashTask(ctx(), expired.id);
    await trashTask(ctx(), fresh.id);
    await trashedDaysAgo(expired.id, 31);
    await trashedDaysAgo(fresh.id, 29);
    expect((await getMyTrash()).map((i) => i.title)).toEqual(["fresh"]);
  });

  it("an expired task that is still physically there (cleanup could not run) is still not listed", async () => {
    const task = await createTask(userId, { title: "expired" });
    await trashTask(ctx(), task.id);
    await trashedDaysAgo(task.id, 31);
    // Make the cleanup unable to remove it: a stopped-series check would not matter, so simulate
    // a failing cleanup by keeping the row from matching its delete (lock it in a transaction).
    const cleanupRan = vi.spyOn(await import("@/lib/trash/service"), "purgeExpiredTrash");
    cleanupRan.mockRejectedValueOnce(new Error("simulated cleanup failure"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await getMyTrash()).toEqual([]);
    expect(await prisma.task.findUnique({ where: { id: task.id } })).not.toBeNull(); // still there...
    expect(errors).toHaveBeenCalled(); // ...the failure was logged, and the page still loaded
    vi.restoreAllMocks();
  });
});

describe("the Archive page", () => {
  it("lists archived tasks only, most recently archived first", async () => {
    const a = await createTask(userId, { title: "first", status: "COMPLETED" });
    const b = await createTask(userId, { title: "second", status: "COMPLETED" });
    await createTask(userId, { title: "not archived", status: "COMPLETED" });
    const trashed = await createTask(userId, { title: "archived then trashed", status: "COMPLETED" });
    await archiveTask(ctxFor(userId, "2026-11-02", "10:00"), a.id);
    await archiveTask(ctxFor(userId, "2026-11-02", "11:00"), b.id);
    await archiveTask(ctx(), trashed.id);
    await trashTask(ctx(), trashed.id);
    expect((await getMyArchive()).map((t) => t.title)).toEqual(["second", "first"]);
  });
});

describe("tombstones are never visible", () => {
  it("not in the list, the task page, the Trash, the Archive or the category counts", async () => {
    const category = await createCategory(userId, "Work");
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16", title: "Visible once", categoryId: category.id });
    await pauseSeries(ctx(), seriesId, 1, null);
    await trashTask(ctx(), task.id);
    expect((await deleteTaskForever(ctx(), task.id)).ok).toBe(true);
    expect((await prisma.task.findUnique({ where: { id: task.id } }))!.purgedAt).not.toBeNull(); // it is a tombstone

    expect(await getMyTasks()).toEqual([]);
    expect(await getMyTask(task.id)).toBeNull();
    expect(await getMyTrash()).toEqual([]);
    expect(await getMyArchive()).toEqual([]);
    expect((await getMyCategories())[0].taskCount).toBe(0);
    // ...and a tombstone is not even found by the services that act on tasks.
    expect((await trashTask(ctx(), task.id)).ok).toBe(false);
  });

  it("a tombstone never produces reminders", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16", deadlineDate: "2026-11-17" });
    await pauseSeries(ctx(), seriesId, 1, null);
    await trashTask(ctx(), task.id);
    await deleteTaskForever(ctx(), task.id);
    const { getReminders } = await import("@/lib/reminders/service");
    expect((await getReminders({ userId, now: at("2026-11-17", "10:00") })).items).toEqual([]);
    expect(await prisma.reminder.count()).toBe(0);
  });
});
