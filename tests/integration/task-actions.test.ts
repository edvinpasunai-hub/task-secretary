// The plain task Server Actions (create, edit, change status) as the browser calls them, against the
// separate test database: what is saved, what is refused, and that one user can never touch another
// user's task. Replaces the checks of the old browser script test-tasks (Stage 4.1). The session and the
// redirect are replaced; everything else is the real code.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: { id: "", name: "T", email: "t@example.invalid", timeZone: "Europe/Tallinn" } }));
vi.mock("@/lib/session", () => ({ requireUser: async () => session.user, getCurrentUser: async () => session.user }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));
vi.mock("next/cache", () => ({ refresh: () => undefined, revalidatePath: () => undefined }));

import { createTask, setTaskStatus, updateTask, type TaskFormState } from "@/app/tasks/actions";
import { dateFromDb, timeFromDb } from "@/lib/local-time";
import { archiveTask, trashTask } from "@/lib/trash/service";

import { createCategory, createTask as seedTask, createUser, ctxFor, prisma, resetDatabase } from "../helpers/db";

let me: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  me = await createUser("me");
  other = await createUser("other");
  session.user.id = me;
});
afterAll(() => prisma.$disconnect());

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ importance: "NORMAL", repeatType: "NEVER", ...fields })) data.set(key, value);
  return data;
};
// Runs an action; a redirect (the success path of the forms) is returned as `redirectedTo`.
async function run(action: () => Promise<TaskFormState | void>): Promise<{ state?: TaskFormState | void; redirectedTo?: string }> {
  try {
    return { state: await action() };
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirectedTo: (error as Error & { redirectTo: string }).redirectTo };
    throw error;
  }
}
const create = (fields: Record<string, string>) => run(() => createTask({}, form(fields)));
const edit = (id: string, fields: Record<string, string>) => run(() => updateTask({}, form({ id, title: "x", ...fields })));
const setStatus = (id: string, status: string) => {
  const data = new FormData();
  data.set("id", id);
  data.set("status", status);
  return run(() => setTaskStatus(data));
};
const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
const count = (userId = me) => prisma.task.count({ where: { userId } });

describe("creating a task", () => {
  it("a minimal task: normal importance, To do, no dates or estimate, owned by the logged-in user", async () => {
    const { redirectedTo } = await create({ title: "Minimal" });
    expect(redirectedTo).toBe("/tasks");
    const task = await prisma.task.findFirstOrThrow({ where: { userId: me } });
    expect(task).toMatchObject({ title: "Minimal", importance: "NORMAL", status: "TODO", plannedDate: null, deadlineDate: null, estimatedMinutes: null, completedAt: null, rescheduleCount: 0, originalDeadlineDate: null, seriesId: null });
  });

  it("a full task stores every field; a deadline with a time is stored as date + time; the first deadline is remembered", async () => {
    await create({ title: "Full", description: "Notes", importance: "HIGH", plannedDate: "2026-11-12", plannedTime: "09:30", deadlineDate: "2026-11-10", deadlineTime: "17:00", durationHours: "1", durationMinutes: "30" });
    const task = await prisma.task.findFirstOrThrow({ where: { userId: me } });
    expect([task.title, task.description, task.importance, dateFromDb(task.plannedDate), timeFromDb(task.plannedTime), dateFromDb(task.deadlineDate), timeFromDb(task.deadlineTime), task.estimatedMinutes]).toEqual(["Full", "Notes", "HIGH", "2026-11-12", "09:30", "2026-11-10", "17:00", 90]);
    expect(dateFromDb(task.originalDeadlineDate)).toBe("2026-11-10");
    expect(task.rescheduleCount).toBe(0);
  });

  it("an empty title is refused with a message, the typed values come back, and nothing is saved", async () => {
    const { state } = await create({ title: "  ", description: "kept text" });
    expect(state && "errors" in state && state.errors?.title).toBe("Please enter a title.");
    expect(state && "values" in state && state.values?.description).toBe("kept text");
    expect(await count()).toBe(0);
  });

  it("tampered importance and an impossible date are refused, and nothing is saved", async () => {
    const urgent = await create({ title: "T", importance: "URGENT" });
    expect(urgent.state && "errors" in urgent.state && urgent.state.errors?.importance).toBeTruthy();
    const impossible = await create({ title: "T", deadlineDate: "2026-02-30" });
    expect(impossible.state && "errors" in impossible.state && impossible.state.errors?.deadlineDate).toBeTruthy();
    expect(await count()).toBe(0);
  });

  it("an injected userId (or status, completedAt, id) in the form is ignored: the task belongs to the logged-in user", async () => {
    await create({ title: "Injected", userId: other, status: "COMPLETED", completedAt: "2020-01-01", id: "forged" });
    expect(await count(other)).toBe(0);
    const task = await prisma.task.findFirstOrThrow({ where: { userId: me } });
    expect([task.status, task.completedAt]).toEqual(["TODO", null]);
  });

  it("another user's category is refused", async () => {
    const theirs = await createCategory(other, "Theirs");
    const { state } = await create({ title: "T", categoryId: theirs.id });
    expect(state && "errors" in state && state.errors?.categoryId).toBeTruthy();
    expect(await count()).toBe(0);
  });
});

describe("where saving leads (no open redirects)", () => {
  it("defaults to the Tasks list; the dashboard only for the exact value; a filter is kept", async () => {
    expect((await create({ title: "a" })).redirectedTo).toBe("/tasks");
    expect((await create({ title: "b", returnFrom: "dashboard" })).redirectedTo).toBe("/");
    expect((await create({ title: "c", returnDue: "overdue" })).redirectedTo).toBe("/tasks?due=overdue");
    const mine = await createCategory(me, "Mine");
    expect((await create({ title: "d", returnCategory: mine.id, returnDue: "later" })).redirectedTo).toBe(`/tasks?category=${mine.id}&due=later`);
  });

  it("hostile or foreign values fall back to the plain Tasks list", async () => {
    const theirs = await createCategory(other, "Theirs");
    const hostile: Array<Record<string, string>> = [{ returnFrom: "https://evil.example" }, { returnFrom: "//evil.example" }, { returnDue: "javascript:alert(1)" }, { returnCategory: "../../x" }, { returnCategory: theirs.id }];
    for (const fields of hostile) {
      const { redirectedTo } = await create({ title: "x", ...fields });
      expect(redirectedTo, JSON.stringify(fields)).toBe("/tasks");
    }
  });
});

describe("editing a task", () => {
  it("saves the new title and deadline: the original deadline is kept and it counts as one reschedule", async () => {
    const task = await seedTask(me, { title: "Old", deadlineDate: "2026-11-10", deadlineTime: "17:00" });
    const { redirectedTo } = await edit(task.id, { title: "New", deadlineDate: "2026-11-15", deadlineTime: "17:00" });
    expect(redirectedTo).toBe("/tasks");
    const after = await row(task.id);
    expect([after.title, dateFromDb(after.deadlineDate), dateFromDb(after.originalDeadlineDate), after.rescheduleCount]).toEqual(["New", "2026-11-15", "2026-11-10", 1]);
  });

  it("changing only the deadline TIME does not count as a reschedule", async () => {
    const task = await seedTask(me, { deadlineDate: "2026-11-10", deadlineTime: "17:00" });
    await edit(task.id, { deadlineDate: "2026-11-10", deadlineTime: "18:30" });
    const after = await row(task.id);
    expect([timeFromDb(after.deadlineTime), after.rescheduleCount]).toEqual(["18:30", 0]);
  });

  it("an invalid edit saves nothing, not even the valid parts", async () => {
    const task = await seedTask(me, { title: "Keep" });
    const { state } = await edit(task.id, { title: "Changed", deadlineDate: "2026-02-30" });
    expect(state && "errors" in state && state.errors?.deadlineDate).toBeTruthy();
    expect((await row(task.id)).title).toBe("Keep");
  });

  it("'Save changes and switch status' saves the edits and the status together, and sets completedAt", async () => {
    const task = await seedTask(me, { title: "Both" });
    await edit(task.id, { title: "Both (edited)", status: "COMPLETED" });
    const after = await row(task.id);
    expect([after.title, after.status, after.completedAt !== null]).toEqual(["Both (edited)", "COMPLETED", true]);
  });

  it("every status can be saved, and leaving 'Completed' clears completedAt", async () => {
    const task = await seedTask(me, {});
    for (const status of ["IN_PROGRESS", "POSTPONED", "COMPLETED", "TODO"] as const) {
      await edit(task.id, { status });
      const after = await row(task.id);
      expect(after.status).toBe(status);
      expect(after.completedAt !== null).toBe(status === "COMPLETED");
    }
  });

  it("a tampered edit that swaps in ANOTHER user's task id is refused and changes nothing", async () => {
    const victim = await seedTask(other, { title: "Victim" });
    const mine = await seedTask(me, { title: "Mine" });
    const before = await row(victim.id);
    const { state } = await edit(victim.id, { title: "HACKED BY ME", description: "x" });
    expect(state && "message" in state && state.message).toBe("This task was not found.");
    expect(await row(victim.id)).toEqual(before); // untouched, including updatedAt
    expect((await row(mine.id)).title).toBe("Mine");
  });

  it("an unknown or malformed id is refused", async () => {
    for (const id of ["", "x", "../x", "cmzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const { state } = await edit(id, { title: "x" });
      expect(state && "message" in state && state.message, id).toBe("This task was not found.");
    }
  });

  it("a task in Trash or the archive cannot be edited", async () => {
    const trashed = await seedTask(me, { title: "Trashed" });
    const archived = await seedTask(me, { title: "Archived", status: "COMPLETED" });
    await trashTask(ctxFor(me), trashed.id);
    await archiveTask(ctxFor(me), archived.id);
    for (const task of [trashed, archived]) {
      const { state } = await edit(task.id, { title: "Changed" });
      expect(state && "message" in state && state.message).toBe("This task was not found.");
    }
    expect([(await row(trashed.id)).title, (await row(archived.id)).title]).toEqual(["Trashed", "Archived"]);
  });
});

describe("changing the status from the list", () => {
  it("Complete sets completedAt; Reopen goes back to To do and clears it", async () => {
    const task = await seedTask(me, { title: "Cycle" });
    await setStatus(task.id, "COMPLETED");
    const done = await row(task.id);
    expect([done.status, done.completedAt !== null]).toEqual(["COMPLETED", true]);
    await setStatus(task.id, "TODO");
    const reopened = await row(task.id);
    expect([reopened.status, reopened.completedAt]).toEqual(["TODO", null]);
  });

  it("a swapped id (another user's task) changes nothing, neither theirs nor mine", async () => {
    const victim = await seedTask(other, { title: "Victim" });
    const mine = await seedTask(me, { title: "Mine" });
    const [victimBefore, mineBefore] = [await row(victim.id), await row(mine.id)];
    await setStatus(victim.id, "COMPLETED");
    expect(await row(victim.id)).toEqual(victimBefore);
    expect(await row(mine.id)).toEqual(mineBefore);
  });

  it("an unknown status, a malformed id, and a task in Trash or the archive are ignored", async () => {
    const task = await seedTask(me, {});
    const trashed = await seedTask(me, {});
    const archived = await seedTask(me, { status: "COMPLETED" });
    await trashTask(ctxFor(me), trashed.id);
    await archiveTask(ctxFor(me), archived.id);
    await setStatus(task.id, "DONE");
    await setStatus("../x", "COMPLETED");
    await setStatus(trashed.id, "COMPLETED");
    await setStatus(archived.id, "TODO");
    expect((await row(task.id)).status).toBe("TODO");
    expect((await row(trashed.id)).status).toBe("TODO");
    expect((await row(archived.id)).status).toBe("COMPLETED");
  });
});
