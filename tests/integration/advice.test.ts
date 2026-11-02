// Stage 6.4: Secretary's Advice as the dashboard computes it (loadDashboard().focus[].advice and .overload), against the separate
// test database: the postponement counter is the persisted one, the overload count covers ALL eligible tasks of the signed-in
// user only, it follows the existing actions, and nothing is written or changed.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: { id: "", name: "Edvin Pasun", email: "t@example.invalid", timeZone: "Europe/Tallinn" } }));
vi.mock("@/lib/session", () => ({ requireUser: async () => session.user, getCurrentUser: async () => session.user }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));
vi.mock("next/cache", () => ({ refresh: () => undefined, revalidatePath: () => undefined }));

import { setTaskStatus } from "@/app/tasks/actions";
import { loadDashboard } from "@/lib/dashboard/queries";
import { postponeTask } from "@/lib/postpone";
import { loadRankedTasks } from "@/lib/ranking/queries";
import { archiveTask, restoreTask, trashTask } from "@/lib/trash/service";

import { at, createTask, createUser, ctxFor, prisma, resetDatabase } from "../helpers/db";
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
const dash = (now: Date = NOW, userId = me, timeZone = "Europe/Tallinn") => loadDashboard({ userId, name: null, timeZone, now });
const overloadOf = async (now?: Date, userId?: string, timeZone?: string) => (await dash(now, userId, timeZone)).overload;
const manyOverdue = async (userId: string, n: number, deadlineDate = "2026-11-05") => {
  for (let i = 0; i < n; i++) await createTask(userId, { title: `o${i}`, deadlineDate });
};
const complete = (id: string) => {
  const data = new FormData();
  data.set("id", id);
  data.set("status", "COMPLETED");
  return setTaskStatus(data);
};

describe("postponement advice uses the persisted counter", () => {
  it("the thresholds and wording on real Focus rows", async () => {
    await createTask(me, { title: "p2", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 2 });
    await createTask(me, { title: "p3", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 3 });
    await createTask(me, { title: "p4", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 4 });
    await createTask(me, { title: "p5", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 5 });
    await createTask(me, { title: "p11", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 11 });
    const by = Object.fromEntries((await dash()).focus.map((i) => [i.title, i.advice]));
    expect(by.p2).toBeNull();
    expect(by.p3).toBe("You've postponed this task 3 times. Consider setting aside time for it.");
    expect(by.p4).toBe("You've postponed this task 4 times. Consider setting aside time for it.");
    expect(by.p5).toBe("Postponed 5 times. Consider breaking this task into smaller steps or revisiting its deadline.");
    expect(by.p11).toContain("Postponed 11 times");
  });

  it("a postponed task outside the top five shows no advice (it has no row)", async () => {
    for (let i = 0; i < 5; i++) await createTask(me, { title: `top ${i}`, priority: "HIGH", deadlineDate: "2026-11-09" });
    await createTask(me, { title: "hidden", priority: "LOW", deadlineDate: "2027-02-01", rescheduleCount: 9 });
    const { focus } = await dash();
    expect(focus.map((i) => i.title)).not.toContain("hidden");
    expect(focus.every((i) => i.advice === null)).toBe(true);
  });

  it("real postponing raises the counter, and the advice appears at the third postponement (and the rank is still the ranking's)", async () => {
    const t = await createTask(me, { title: "slippery", priority: "HIGH", deadlineDate: "2026-11-10" });
    const ctx = { userId: me, timeZone: "Europe/Tallinn", now: NOW };
    let deadline = "2026-11-10";
    for (const next of ["2026-11-11", "2026-11-12", "2026-11-13"]) {
      expect((await dash()).focus[0].advice).toBeNull();
      const result = await postponeTask(ctx, { taskId: t.id, newDate: next, expectedDeadlineDate: deadline });
      expect(result.ok).toBe(true);
      deadline = next;
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).rescheduleCount).toBe(3);
    expect((await dash()).focus[0].advice).toBe("You've postponed this task 3 times. Consider setting aside time for it.");
  });

  it("completing a task removes its advice with it", async () => {
    const t = await createTask(me, { title: "done soon", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 6 });
    expect((await dash()).focus[0].advice).toContain("Postponed 6 times");
    await complete(t.id);
    expect((await dash()).focus).toEqual([]);
  });

  it("a trashed or archived task has no advice; restoring brings it back", async () => {
    const t = await createTask(me, { title: "bounce", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 4 });
    await trashTask(ctxFor(me), t.id);
    expect((await dash()).focus).toEqual([]);
    await restoreTask(ctxFor(me), t.id);
    expect((await dash()).focus[0].advice).toContain("4 times");
  });

  it("a recurring occurrence's counter is its own: a new occurrence starts at 0, so no advice", async () => {
    const { task } = await makeRecurring(me, { type: "WEEKLY", title: "weekly", deadlineDate: "2026-11-09", plannedDate: "2026-11-09", priority: "HIGH" });
    await prisma.task.update({ where: { id: task.id }, data: { rescheduleCount: 5 } });
    expect((await dash()).focus.find((i) => i.id === task.id)?.advice).toContain("Postponed 5 times");
    await complete(task.id);
    const items = (await dash()).focus;
    expect(items.find((i) => i.id === task.id)).toBeUndefined();
    expect(items.every((i) => i.advice === null)).toBe(true);
  });
});

describe("the overload warning", () => {
  it("7 overdue/due-today tasks: no warning", async () => {
    await manyOverdue(me, 4);
    for (let i = 0; i < 3; i++) await createTask(me, { deadlineDate: "2026-11-10" });
    expect(await overloadOf()).toBeNull();
  });

  it("8: exactly one warning with the count; 9 and more: still one, with the right count", async () => {
    await manyOverdue(me, 5);
    for (let i = 0; i < 3; i++) await createTask(me, { deadlineDate: "2026-11-10" });
    expect(await overloadOf()).toEqual({ count: 8, title: "A busy day ahead", message: "You have 8 tasks overdue or due today. Consider choosing a few to focus on first." });
    await createTask(me, { deadlineDate: "2026-11-10" });
    await createTask(me, { deadlineDate: "2026-11-01" });
    const o = await overloadOf();
    expect(o?.count).toBe(10);
    expect(o?.message).toBe("You have 10 tasks overdue or due today. Consider choosing a few to focus on first.");
  });

  it("counts ALL eligible tasks, not only the five shown", async () => {
    await manyOverdue(me, 12);
    const d = await dash();
    expect(d.focus).toHaveLength(5);
    expect(d.overload?.count).toBe(12);
  });

  it("agrees with the Daily briefing (overdue + due today) and never counts a task twice", async () => {
    await manyOverdue(me, 5);
    for (let i = 0; i < 4; i++) await createTask(me, { deadlineDate: "2026-11-10", deadlineTime: "20:00" });
    const d = await dash();
    expect(d.overload?.count).toBe(d.briefing.overdue + d.briefing.dueToday);
    expect(d.overload?.count).toBe(9);
  });

  it("future, tomorrow and no-due-date tasks do not count", async () => {
    await manyOverdue(me, 7);
    for (let i = 0; i < 6; i++) await createTask(me, { deadlineDate: i % 2 ? "2026-11-11" : "2026-12-24" });
    for (let i = 0; i < 4; i++) await createTask(me, { createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(await overloadOf()).toBeNull();
    await createTask(me, { deadlineDate: "2026-11-10" });
    expect((await overloadOf())?.count).toBe(8);
  });

  it("completed, archived, trashed tasks and finished/deleted recurring occurrences are excluded", async () => {
    await manyOverdue(me, 7);
    await createTask(me, { deadlineDate: "2026-11-05", status: "COMPLETED" });
    const archived = await createTask(me, { deadlineDate: "2026-11-05", status: "COMPLETED" });
    await archiveTask(ctxFor(me), archived.id);
    const trashed = await createTask(me, { deadlineDate: "2026-11-05" });
    await trashTask(ctxFor(me), trashed.id);
    const { task: occurrence } = await makeRecurring(me, { type: "WEEKLY", title: "gone", deadlineDate: "2026-11-05", plannedDate: "2026-11-05" });
    await trashTask(ctxFor(me), occurrence.id);
    expect(await overloadOf()).toBeNull(); // 7 left
    await createTask(me, { deadlineDate: "2026-11-05" });
    expect((await overloadOf())?.count).toBe(8);
  });

  it("another user's tasks never affect it (neither adding nor removing)", async () => {
    await manyOverdue(me, 3);
    await manyOverdue(other, 20);
    expect(await overloadOf()).toBeNull();
    expect((await overloadOf(NOW, other))?.count).toBe(20);
    expect((await dash(NOW, me)).focus.every((i) => i.title.startsWith("o"))).toBe(true);
    await prisma.task.deleteMany({ where: { userId: other } });
    await manyOverdue(me, 5);
    expect((await overloadOf())?.count).toBe(8);
  });

  it("follows the existing actions: complete, postpone, trash and restore", async () => {
    await manyOverdue(me, 8);
    expect((await overloadOf())?.count).toBe(8);
    const [a, b, c] = await prisma.task.findMany({ where: { userId: me }, orderBy: { id: "asc" } });
    await complete(a.id);
    expect(await overloadOf()).toBeNull(); // 7
    await trashTask(ctxFor(me), b.id);
    expect((await dash()).overload).toBeNull(); // 6
    await restoreTask(ctxFor(me), b.id);
    expect((await dash()).overload).toBeNull(); // restored: back to 7
    await createTask(me, { deadlineDate: "2026-11-10" });
    expect((await overloadOf())?.count).toBe(8);
    const result = await postponeTask({ userId: me, timeZone: "Europe/Tallinn", now: NOW }, { taskId: c.id, newDate: "2026-11-20", expectedDeadlineDate: "2026-11-05" });
    expect(result.ok).toBe(true);
    expect(await overloadOf()).toBeNull(); // c is no longer overdue
  });

  it("uses the user's time zone and the same overdue rule as the ranking (date boundary)", async () => {
    for (let i = 0; i < 8; i++) await createTask(me, { deadlineDate: "2026-11-10" });
    const lateNov9 = new Date("2026-11-09T21:30:00Z"); // 23:30 on the 9th in Tallinn
    const earlyNov10 = new Date("2026-11-09T22:30:00Z"); // 00:30 on the 10th in Tallinn
    expect(await overloadOf(lateNov9)).toBeNull(); // due tomorrow
    expect((await overloadOf(earlyNov10))?.count).toBe(8); // due today
    expect((await overloadOf(lateNov9, me, "Pacific/Auckland"))?.count).toBe(8); // already the 10th there
  });

  it("is derived from the same ranking the Focus list uses", async () => {
    await manyOverdue(me, 9);
    const ranked = await loadRankedTasks({ userId: me, timeZone: "Europe/Tallinn", now: NOW });
    expect(ranked.filter((r) => ["OVERDUE", "TODAY"].includes(r.breakdown.urgencyLevel))).toHaveLength(9);
    expect((await overloadOf())?.count).toBe(9);
  });
});

describe("nothing is changed or stored", () => {
  it("loading the dashboard with advice and a warning writes nothing", async () => {
    await manyOverdue(me, 9);
    await createTask(me, { title: "stuck", priority: "HIGH", deadlineDate: "2026-11-05", rescheduleCount: 6 });
    const snapshot = async () => JSON.stringify(await prisma.task.findMany({ orderBy: { id: "asc" } }));
    const before = await snapshot();
    await dash();
    await dash();
    expect(await snapshot()).toBe(before);
    expect(await prisma.reminder.count()).toBe(0);
  });

  it("the advice neither changes the ranking order nor exposes a score, and no advice/score column exists", async () => {
    await createTask(me, { title: "a", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 0 });
    await createTask(me, { title: "b", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 9 });
    const { focus, overload } = await dash();
    const ranked = await loadRankedTasks({ userId: me, timeZone: "Europe/Tallinn", now: NOW });
    expect(focus.map((i) => i.id)).toEqual(ranked.map((r) => r.task.id));
    expect(JSON.stringify({ focus, overload })).not.toMatch(/score|points|breakdown|userId/i);
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`select column_name from information_schema.columns where table_schema = 'public' and (column_name ilike '%advice%' or column_name ilike '%overload%' or column_name ilike '%score%')`;
    expect(columns).toEqual([]);
  });
});
