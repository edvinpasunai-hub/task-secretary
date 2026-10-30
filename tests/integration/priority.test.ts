// Stage 6.1: task priority (High / Medium / Low, default Medium) end to end, against the separate test
// database: the default, creating, editing, validation, ownership, and how it behaves for repeating tasks.
// The session and the redirect are replaced; everything else is the real code.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: { id: "", name: "T", email: "t@example.invalid", timeZone: "Europe/Tallinn" } }));
vi.mock("@/lib/session", () => ({ requireUser: async () => session.user, getCurrentUser: async () => session.user }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));
vi.mock("next/cache", () => ({ refresh: () => undefined, revalidatePath: () => undefined }));

import { createTask, updateTask, type TaskFormState } from "@/app/tasks/actions";
import { postponeTask } from "@/lib/postpone";
import { completeTask, convertToRecurring, updateTaskAndSeries } from "@/lib/recurrence/service";
import { archiveTask, restoreTask, trashTask } from "@/lib/trash/service";

import { createTask as seedTask, createUser, ctxFor, instancesOf, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring, seriesRow } from "../helpers/recurrence";

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
  for (const [key, value] of Object.entries({ repeatType: "NEVER", ...fields })) data.set(key, value);
  return data;
};
async function run(action: () => Promise<TaskFormState | void>): Promise<{ state?: TaskFormState | void; redirectedTo?: string }> {
  try {
    return { state: await action() };
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirectedTo: (error as Error & { redirectTo: string }).redirectTo };
    throw error;
  }
}
const create = (fields: Record<string, string>) => run(() => createTask({}, form({ title: "A task", ...fields })));
const edit = (id: string, fields: Record<string, string>) => run(() => updateTask({}, form({ id, title: "A task", ...fields })));
const errorOf = (result: { state?: TaskFormState | void }, field: string) => (result.state && "errors" in result.state ? (result.state.errors as Record<string, string> | undefined)?.[field] : undefined);
const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
const count = (userId = me) => prisma.task.count({ where: { userId } });
const ctx = (date = "2026-11-02", time = "12:00") => ctxFor(me, date, time);
// A task row without the two columns that are expected to change (the priority itself, and updatedAt).
const withoutPriority = (value: Record<string, unknown>) => {
  const copy = { ...value };
  delete copy.priority;
  delete copy.updatedAt;
  return copy;
};

describe("the default", () => {
  it("a task created without choosing anything is Medium (the database default)", async () => {
    await prisma.$executeRaw`insert into tasks (id, "userId", title, "updatedAt") values ('rawdefault00000000000001', ${me}, 'Raw insert', now())`;
    expect((await row("rawdefault00000000000001")).priority).toBe("MEDIUM");
    const viaPrisma = await prisma.task.create({ data: { userId: me, title: "Prisma create" } });
    expect(viaPrisma.priority).toBe("MEDIUM");
    const series = await prisma.recurringSeries.create({ data: { userId: me, type: "DAILY", weekdays: [], anchorDate: new Date("2026-11-02T00:00:00Z"), title: "s", state: "ACTIVE" } });
    expect(series.priority).toBe("MEDIUM");
  });

  it("the database accepts only High, Medium and Low (not the old 'Normal', not anything else)", async () => {
    const task = await seedTask(me, {});
    for (const value of ["NORMAL", "URGENT", "high", "", "0"]) {
      await expect(prisma.$executeRawUnsafe(`update tasks set priority = '${value}'::"Priority" where id = '${task.id}'`), value).rejects.toThrow();
    }
    expect((await row(task.id)).priority).toBe("MEDIUM");
  });
});

describe("creating a task", () => {
  it("saves each of the three priorities, and the form's default (Medium) is saved as Medium", async () => {
    for (const priority of ["HIGH", "MEDIUM", "LOW"]) {
      const { redirectedTo } = await create({ title: `P ${priority}`, priority });
      expect(redirectedTo).toBe("/tasks");
      expect((await prisma.task.findFirstOrThrow({ where: { userId: me, title: `P ${priority}` } })).priority).toBe(priority);
    }
  });

  it("refuses the old value NORMAL, forged values, and a missing priority; nothing is saved and the typed text comes back", async () => {
    for (const priority of ["NORMAL", "URGENT", "high", "Medium", "", " HIGH", "HIGH;DROP TABLE tasks"]) {
      const result = await create({ title: "Should not exist", description: "typed", priority });
      expect(errorOf(result, "priority"), JSON.stringify(priority)).toBe("Please choose High, Medium or Low.");
      expect(result.state && "values" in result.state && result.state.values?.description).toBe("typed");
    }
    const missing = await run(() => createTask({}, form({ title: "No priority sent" })));
    expect(errorOf(missing, "priority")).toBeTruthy();
    const stale = await create({ title: "From a stale page", importance: "HIGH" }); // the old field name
    expect(errorOf(stale, "priority")).toBeTruthy();
    expect(await count()).toBe(0);
  });

  it("an injected userId cannot create a task for someone else, whatever its priority", async () => {
    await create({ title: "Injected", priority: "HIGH", userId: other });
    expect(await count(other)).toBe(0);
    expect(await count(me)).toBe(1);
  });
});

describe("editing a task", () => {
  it("changes the priority and nothing else", async () => {
    const task = await seedTask(me, { title: "Keep me", description: "notes", priority: "LOW", deadlineDate: "2026-11-10", deadlineTime: "17:00", plannedDate: "2026-11-09", estimatedMinutes: 45 });
    const before = await row(task.id);
    const { redirectedTo } = await edit(task.id, { title: "Keep me", description: "notes", priority: "HIGH", deadlineDate: "2026-11-10", deadlineTime: "17:00", plannedDate: "2026-11-09", durationMinutes: "45" });
    expect(redirectedTo).toBe("/tasks");
    const after = await row(task.id);
    expect(after.priority).toBe("HIGH");
    expect(withoutPriority(after)).toEqual(withoutPriority(before)); // every other column, byte for byte
  });

  it("can set each of the three values, in any order", async () => {
    const task = await seedTask(me, {});
    for (const priority of ["HIGH", "LOW", "MEDIUM", "HIGH", "MEDIUM"]) {
      await edit(task.id, { priority });
      expect((await row(task.id)).priority).toBe(priority);
    }
  });

  it("an invalid or forged value is refused and the task is unchanged (including its other edits)", async () => {
    const task = await seedTask(me, { title: "Original", priority: "LOW" });
    const before = await row(task.id);
    for (const priority of ["NORMAL", "URGENT", "", "medium"]) {
      const result = await edit(task.id, { title: "Changed", priority });
      expect(errorOf(result, "priority"), priority).toBeTruthy();
    }
    expect(await row(task.id)).toEqual(before);
  });

  it("Save-and-switch-status keeps the chosen priority together with the new status", async () => {
    const task = await seedTask(me, { priority: "MEDIUM" });
    await edit(task.id, { priority: "HIGH", status: "IN_PROGRESS" });
    const after = await row(task.id);
    expect([after.priority, after.status]).toEqual(["HIGH", "IN_PROGRESS"]);
  });

  it("another user's task cannot be edited, not even its priority (a swapped task id is refused)", async () => {
    const victim = await seedTask(other, { title: "Victim", priority: "LOW" });
    const before = await row(victim.id);
    const result = await edit(victim.id, { title: "Victim", priority: "HIGH" });
    expect(result.state && "message" in result.state && result.state.message).toBe("This task was not found.");
    expect(await row(victim.id)).toEqual(before);
  });

  it("tasks in Trash or the archive cannot be edited, so their priority cannot change either", async () => {
    const trashed = await seedTask(me, { priority: "LOW" });
    const archived = await seedTask(me, { priority: "LOW", status: "COMPLETED" });
    await trashTask(ctx(), trashed.id);
    await archiveTask(ctx(), archived.id);
    for (const task of [trashed, archived]) {
      const result = await edit(task.id, { priority: "HIGH" });
      expect(result.state && "message" in result.state && result.state.message).toBe("This task was not found.");
      expect((await row(task.id)).priority).toBe("LOW");
    }
  });
});

describe("other actions keep the priority", () => {
  it("postponing, trashing, restoring and archiving never change it", async () => {
    const task = await seedTask(me, { priority: "HIGH", deadlineDate: "2026-11-02" });
    await postponeTask({ userId: me, timeZone: "Europe/Tallinn", now: new Date("2026-11-02T10:00:00Z") }, { taskId: task.id, newDate: "2026-11-05", expectedDeadlineDate: "2026-11-02" });
    expect((await row(task.id)).priority).toBe("HIGH");
    await trashTask(ctx(), task.id);
    await restoreTask(ctx(), task.id);
    expect((await row(task.id)).priority).toBe("HIGH");
    const done = await seedTask(me, { priority: "LOW", status: "COMPLETED" });
    await archiveTask(ctx(), done.id);
    expect((await row(done.id)).priority).toBe("LOW");
  });
});

describe("repeating tasks", () => {
  it("creating a repeating task with a priority: the series template and the first task have it, and the next occurrence copies it", async () => {
    await create({ title: "Weekly", priority: "LOW", plannedDate: "2026-11-02", repeatType: "WEEKLY" });
    const first = await prisma.task.findFirstOrThrow({ where: { userId: me, title: "Weekly" } });
    const series = await seriesRow(first.seriesId!);
    expect([first.priority, series.priority]).toEqual(["LOW", "LOW"]);
    await completeTask(ctx("2026-11-02"), first.id);
    const rows = await instancesOf(first.seriesId!);
    expect(rows.map((r) => r.priority)).toEqual(["LOW", "LOW"]);
  });

  it("turning an ordinary task into a repeating one carries its priority into the series and the next occurrence", async () => {
    const task = await seedTask(me, { priority: "HIGH", plannedDate: "2026-11-02" });
    const converted = await convertToRecurring(ctx(), task.id, { type: "WEEKLY" });
    expect(converted.ok).toBe(true);
    const seriesId = (await row(task.id)).seriesId!;
    expect((await seriesRow(seriesId)).priority).toBe("HIGH");
    await completeTask(ctx("2026-11-02"), task.id);
    expect((await instancesOf(seriesId)).map((r) => r.priority)).toEqual(["HIGH", "HIGH"]);
  });

  it("'Only this task': the priority of ONE occurrence changes; the series template, its version and the other occurrences do not", async () => {
    const { task, seriesId } = await makeRecurring(userId(), { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM" });
    await completeTask(ctx("2026-11-02"), task.id); // creates the 9 Nov occurrence
    const [done, open] = await instancesOf(seriesId);
    const seriesBefore = await seriesRow(seriesId);

    const result = await edit(open.id, { priority: "HIGH", scope: "TASK", plannedDate: "2026-11-09", seriesVersion: String(seriesBefore.version) });
    expect(result.redirectedTo).toBe("/tasks");
    expect((await row(open.id)).priority).toBe("HIGH");
    expect((await row(done.id)).priority).toBe("MEDIUM");
    expect(await seriesRow(seriesId)).toEqual(seriesBefore); // template, version, rule: untouched
    // The NEXT occurrence is still created from the series template, not from this one-off change.
    await completeTask(ctx("2026-11-09"), open.id);
    const rows = await instancesOf(seriesId);
    expect(rows.map((r) => r.priority)).toEqual(["MEDIUM", "HIGH", "MEDIUM"]);
  });

  it("'This and future tasks': the series template and every unfinished occurrence change; finished ones and the history do not", async () => {
    const { task, seriesId } = await makeRecurring(userId(), { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM" });
    await completeTask(ctx("2026-11-02"), task.id);
    const [done, open] = await instancesOf(seriesId);
    const version = (await seriesRow(seriesId)).version;

    const result = await updateTaskAndSeries(ctx(), open.id, version, { priority: "HIGH" }, null);
    expect(result.ok).toBe(true);
    const series = await seriesRow(seriesId);
    expect(series.priority).toBe("HIGH");
    expect(series.version).toBe(version + 1); // the existing version-checked update
    expect((await row(open.id)).priority).toBe("HIGH");
    expect((await row(done.id)).priority).toBe("MEDIUM"); // finished history is left alone
    await completeTask(ctx("2026-11-09"), open.id);
    expect((await instancesOf(seriesId)).map((r) => r.priority)).toEqual(["MEDIUM", "HIGH", "HIGH"]);
  });

  it("'This and future tasks' with a stale series version is refused and nothing changes", async () => {
    const { task, seriesId } = await makeRecurring(userId(), { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM" });
    const result = await updateTaskAndSeries(ctx(), task.id, 99, { priority: "HIGH" }, null);
    expect(result.ok).toBe(false);
    expect((await seriesRow(seriesId)).priority).toBe("MEDIUM");
    expect((await row(task.id)).priority).toBe("MEDIUM");
  });

  it("changing something else for 'this and future tasks' does not overwrite an occurrence's own priority", async () => {
    const { task, seriesId } = await makeRecurring(userId(), { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM", title: "Weekly" });
    await completeTask(ctx("2026-11-02"), task.id);
    const [, open] = await instancesOf(seriesId);
    await edit(open.id, { title: "Weekly", priority: "LOW", scope: "TASK", plannedDate: "2026-11-09" }); // this occurrence only
    const version = (await seriesRow(seriesId)).version;
    const result = await updateTaskAndSeries(ctx(), open.id, version, { title: "Weekly (renamed)" }, null);
    expect(result.ok).toBe(true);
    const after = await row(open.id);
    expect([after.title, after.priority]).toEqual(["Weekly (renamed)", "LOW"]); // only the changed field is applied
    expect((await seriesRow(seriesId)).priority).toBe("MEDIUM");
  });

  it("another user cannot change the priority of my repeating series", async () => {
    const { task, seriesId } = await makeRecurring(userId(), { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM" });
    const version = (await seriesRow(seriesId)).version;
    const result = await updateTaskAndSeries(ctxFor(other, "2026-11-02"), task.id, version, { priority: "HIGH" }, null);
    expect(result.ok).toBe(false);
    expect((await seriesRow(seriesId)).priority).toBe("MEDIUM");
    expect((await row(task.id)).priority).toBe("MEDIUM");
  });

  it("an invalid priority in a series update is refused", async () => {
    const { task, seriesId } = await makeRecurring(userId(), { type: "WEEKLY", plannedDate: "2026-11-02", priority: "MEDIUM" });
    const version = (await seriesRow(seriesId)).version;
    for (const priority of ["NORMAL", "URGENT", ""]) {
      const result = await updateTaskAndSeries(ctx(), task.id, version, { priority } as never, null);
      expect(result.ok, priority).toBe(false);
    }
    expect((await seriesRow(seriesId)).priority).toBe("MEDIUM");
  });
});

function userId() {
  return me;
}
