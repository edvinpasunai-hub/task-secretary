// Stage 6.3: Secretary's Focus as the dashboard computes it (loadDashboard().focus), against the separate test database:
// the top five from the REAL ranking engine, who is eligible, user isolation, completing a Focus task through the existing
// action, the Daily briefing counters, time zone / clock-change consistency, and that nothing is stored.

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
import { nowInTimeZone } from "@/lib/local-time";
import { loadRankedTasks } from "@/lib/ranking/queries";
import { postponeTask } from "@/lib/postpone";
import { addDays } from "@/lib/recurrence/civil-date";
import { archiveTask, deleteTaskForever, restoreTask, trashTask } from "@/lib/trash/service";

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
const focus = async (now: Date = NOW, userId = me, timeZone = "Europe/Tallinn") => (await loadDashboard({ userId, name: null, timeZone, now })).focus;
const titles = (items: Array<{ title: string }>) => items.map((i) => i.title);
const complete = (id: string) => {
  const data = new FormData();
  data.set("id", id);
  data.set("status", "COMPLETED");
  return setTaskStatus(data);
};

describe("which tasks are shown", () => {
  it("the five highest-ranked tasks, in the ranking's order (the real engine decides)", async () => {
    await createTask(me, { title: "A overdue high", priority: "HIGH", deadlineDate: "2026-11-09" }); // 110
    await createTask(me, { title: "B overdue medium", priority: "MEDIUM", deadlineDate: "2026-11-08" }); // 85
    await createTask(me, { title: "C today high", priority: "HIGH", deadlineDate: "2026-11-10" }); // 90
    await createTask(me, { title: "D tomorrow high", priority: "HIGH", deadlineDate: "2026-11-11" }); // 75
    await createTask(me, { title: "E overdue low", priority: "LOW", deadlineDate: "2026-11-05" }); // 60
    await createTask(me, { title: "F no due, 30 days", priority: "MEDIUM", createdAt: new Date("2026-10-11T07:00:00Z") }); // 40
    await createTask(me, { title: "G later low", priority: "LOW", deadlineDate: "2026-12-30" }); // 0
    await createTask(me, { title: "H new low", priority: "LOW" }); // 0

    const items = await focus();
    expect(items).toHaveLength(5);
    expect(titles(items)).toEqual(["A overdue high", "C today high", "B overdue medium", "D tomorrow high", "E overdue low"]);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
    // The same order the Stage 6.2 loader gives (Focus is just its first five)
    const ranked = await loadRankedTasks({ userId: me, now: NOW, timeZone: "Europe/Tallinn" });
    expect(ranked).toHaveLength(8);
    expect(items.map((i) => i.id)).toEqual(ranked.slice(0, 5).map((r) => r.task.id));
  });

  it("fewer than five eligible tasks: all of them; none: an empty list", async () => {
    expect(await focus()).toEqual([]);
    await createTask(me, { title: "only one", priority: "LOW" });
    await createTask(me, { title: "second", priority: "HIGH", deadlineDate: "2026-11-10" });
    expect(titles(await focus())).toEqual(["second", "only one"]);
  });

  it("only active, unfinished tasks: not finished, archived, in Trash, tombstones, or someone else's", async () => {
    const keep = await createTask(me, { title: "keep", priority: "LOW" });
    await createTask(me, { title: "in progress", status: "IN_PROGRESS", priority: "LOW" });
    await createTask(me, { title: "postponed", status: "POSTPONED", priority: "LOW" });
    await createTask(me, { title: "done", status: "COMPLETED", priority: "HIGH", deadlineDate: "2026-11-01" });
    const archived = await createTask(me, { title: "archived", status: "COMPLETED", priority: "HIGH", deadlineDate: "2026-11-01" });
    const trashed = await createTask(me, { title: "trashed", priority: "HIGH", deadlineDate: "2026-11-01" });
    await createTask(other, { title: "theirs", priority: "HIGH", deadlineDate: "2026-11-01" });
    await archiveTask(ctxFor(me), archived.id);
    await trashTask(ctxFor(me), trashed.id);
    const { task, seriesId } = await makeRecurring(me, { type: "WEEKLY", plannedDate: "2026-11-16", deadlineDate: "2026-11-09", priority: "HIGH", title: "tombstoned" });
    await prisma.recurringSeries.update({ where: { id: seriesId }, data: { state: "PAUSED" } });
    await trashTask(ctxFor(me), task.id);
    await deleteTaskForever(ctxFor(me), task.id); // leaves a tombstone

    expect(titles(await focus()).sort()).toEqual(["in progress", "keep", "postponed"]);
    expect(keep.id).toBeTruthy();
  });

  it("never another user's tasks: each user's Focus holds only their own", async () => {
    await createTask(me, { title: "mine", priority: "LOW" });
    await createTask(other, { title: "theirs overdue high", priority: "HIGH", deadlineDate: "2026-11-01" });
    expect(titles(await focus(NOW, me))).toEqual(["mine"]);
    expect(titles(await focus(NOW, other))).toEqual(["theirs overdue high"]);
  });

  it("a task that is trashed, archived or finished leaves Focus, and returns when restored", async () => {
    const task = await createTask(me, { title: "moving", priority: "HIGH", deadlineDate: "2026-11-10" });
    expect(titles(await focus())).toEqual(["moving"]);
    await trashTask(ctxFor(me), task.id);
    expect(await focus()).toEqual([]);
    await restoreTask(ctxFor(me), task.id);
    expect(titles(await focus())).toEqual(["moving"]);
  });

  it("postponing changes both the wording and the position at the next render", async () => {
    const task = await createTask(me, { title: "to postpone", priority: "HIGH", deadlineDate: "2026-11-10" });
    await createTask(me, { title: "steady", priority: "MEDIUM", deadlineDate: "2026-11-11" }); // 50
    expect((await focus())[0]).toMatchObject({ title: "to postpone", reason: "High priority and due today" }); // 90
    await postponeTask({ userId: me, timeZone: "Europe/Tallinn", now: NOW }, { taskId: task.id, newDate: "2026-11-20", expectedDeadlineDate: "2026-11-10" });
    const after = await focus();
    expect(titles(after)).toEqual(["steady", "to postpone"]); // High + later (50)... ties with steady (50): earlier due first
    expect(after[1].reason).toBe("High priority, due in 10 days");
  });
});

describe("explanations and labels come from the real task", () => {
  it("overdue, today, tomorrow, no due date: each is described correctly (and never as another)", async () => {
    await createTask(me, { title: "overdue", priority: "HIGH", deadlineDate: "2026-11-09" });
    await createTask(me, { title: "today", priority: "HIGH", deadlineDate: "2026-11-10", deadlineTime: "18:00" });
    await createTask(me, { title: "tomorrow", priority: "HIGH", deadlineDate: "2026-11-11" });
    await createTask(me, { title: "old no due", priority: "MEDIUM", createdAt: new Date("2026-10-01T08:00:00Z") });
    await createTask(me, { title: "new no due", priority: "LOW", createdAt: new Date("2026-11-09T08:00:00Z") }); // 1 day old at the test's fixed moment
    const items = await focus();
    const by = (title: string) => items.find((i) => i.title === title)!;
    expect(by("overdue")).toMatchObject({ priorityLabel: "High", dueLabel: "Overdue since Mon, 9 Nov", reason: "High priority and overdue" });
    expect(by("today")).toMatchObject({ priorityLabel: "High", dueLabel: "Due today, 18:00", reason: "High priority and due today" });
    expect(by("tomorrow")).toMatchObject({ priorityLabel: "High", dueLabel: "Due tomorrow", reason: "High priority, due tomorrow" });
    expect(by("old no due")).toMatchObject({ priorityLabel: "Medium", dueLabel: "No due date", reason: "Waiting for 30+ days" });
    expect(by("new no due")).toMatchObject({ priorityLabel: "Low", dueLabel: "No due date", reason: "Low priority, no due date" });
  });

  it("a timed deadline that passed today is 'overdue', one still ahead is 'due today' (the existing time-aware rule)", async () => {
    await createTask(me, { title: "passed", priority: "MEDIUM", deadlineDate: "2026-11-10", deadlineTime: "09:00" });
    await createTask(me, { title: "ahead", priority: "MEDIUM", deadlineDate: "2026-11-10", deadlineTime: "16:00" });
    const items = await focus();
    expect(items.find((i) => i.title === "passed")).toMatchObject({ reason: "Overdue and needs attention", dueLabel: "Overdue since Tue, 10 Nov, 09:00" });
    expect(items.find((i) => i.title === "ahead")).toMatchObject({ reason: "Due today", dueLabel: "Due today, 16:00" });
  });

  it("the time zone and the clock-change days are the same as in the ranking", async () => {
    await createTask(me, { title: "due on the 30th", priority: "HIGH", deadlineDate: "2026-03-30" });
    expect((await focus(new Date("2026-03-29T20:59:59Z")))[0]).toMatchObject({ dueLabel: "Due tomorrow", reason: "High priority, due tomorrow" }); // last second of the 23-hour day
    expect((await focus(new Date("2026-03-29T21:00:00Z")))[0]).toMatchObject({ dueLabel: "Due today", reason: "High priority and due today" });
    await prisma.task.deleteMany({ where: { userId: me } });
    await createTask(me, { title: "due on the 26th", priority: "HIGH", deadlineDate: "2026-10-26" });
    expect((await focus(new Date("2026-10-25T21:59:59Z")))[0].reason).toBe("High priority, due tomorrow"); // last second of the 25-hour day
    expect((await focus(new Date("2026-10-25T22:00:00Z")))[0].reason).toBe("High priority and due today");
    await prisma.task.deleteMany({ where: { userId: me } });
    await createTask(me, { title: "due on the 11th", priority: "HIGH", deadlineDate: "2026-11-11" });
    const moment = new Date("2026-11-10T22:30:00Z"); // 00:30 on the 11th in Tallinn, 17:30 on the 10th in New York
    expect((await focus(moment, me, "Europe/Tallinn"))[0].reason).toBe("High priority and due today");
    expect((await focus(moment, me, "America/New_York"))[0].reason).toBe("High priority, due tomorrow");
  });
});

describe("completing a Focus task (the existing action)", () => {
  const today = () => nowInTimeZone("Europe/Tallinn").date;

  it("it leaves Focus, the next eligible task takes its place, and the Daily briefing counters stay correct", async () => {
    const t = today();
    const created: Record<string, string> = {};
    for (const [name, priority, deadlineDate] of [
      ["T1", "HIGH", addDays(t, -2)],
      ["T2", "HIGH", t],
      ["T3", "MEDIUM", addDays(t, -1)],
      ["T4", "HIGH", addDays(t, 1)],
      ["T5", "LOW", addDays(t, -3)],
      ["T6", "MEDIUM", addDays(t, 2)],
      ["T7", "LOW", null],
    ] as const) created[name] = (await createTask(me, { title: name, priority, deadlineDate })).id;

    const dash = () => loadDashboard({ userId: me, name: null, timeZone: "Europe/Tallinn" });
    const before = await dash();
    expect(titles(before.focus)).toEqual(["T1", "T2", "T3", "T4", "T5"]); // T6 (+... 25+15 = 40) is sixth
    expect(before.briefing).toMatchObject({ completedToday: 0 });

    await complete(created.T1); // the existing server action, exactly as the check button posts it
    const after = await dash();
    expect(titles(after.focus)).toEqual(["T2", "T3", "T4", "T5", "T6"]); // T1 gone, T6 came in
    expect(after.focus.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(after.briefing.completedToday).toBe(1); // "Completed today" keeps working
    expect(after.briefing.overdue).toBe(before.briefing.overdue - 1); // the Daily briefing and sections follow too
    expect(after.counts.overdue + after.counts.today + after.counts.upcoming + after.counts.later + after.counts.none).toBe(6);
  });

  it("completing a repeating task's current occurrence brings its successor into the ranking like any other task", async () => {
    const { task, seriesId } = await makeRecurring(me, { type: "DAILY", plannedDate: today(), deadlineDate: today(), priority: "HIGH", title: "Daily" });
    const dash = () => loadDashboard({ userId: me, name: null, timeZone: "Europe/Tallinn" });
    expect((await dash()).focus.map((i) => i.id)).toEqual([task.id]);
    await complete(task.id);
    const rows = await prisma.task.findMany({ where: { seriesId }, orderBy: { occurrenceKey: "asc" } });
    expect(rows).toHaveLength(2);
    const items = (await dash()).focus;
    expect(items.map((i) => i.id)).toEqual([rows[1].id]); // the finished occurrence is gone; the new one is recommended, once
    expect(items[0].priority).toBe("HIGH");
  });

  it("a second completion request for the same task changes nothing and Focus stays consistent", async () => {
    const t = await createTask(me, { title: "once", priority: "HIGH", deadlineDate: today() });
    await Promise.all([complete(t.id), complete(t.id), complete(t.id)]);
    const dash = await loadDashboard({ userId: me, name: null, timeZone: "Europe/Tallinn" });
    expect(dash.focus).toEqual([]);
    expect(dash.briefing.completedToday).toBe(1);
  });
});

describe("privacy and what is stored", () => {
  it("the Focus rows contain no score, points, breakdown, description or owner", async () => {
    await createTask(me, { title: "private title", description: "private notes", priority: "HIGH", deadlineDate: "2026-11-09" });
    const items = await focus();
    expect(Object.keys(items[0]).sort()).toEqual(["advice", "dueLabel", "id", "priority", "priorityLabel", "rank", "reason", "title"]);
    const json = JSON.stringify(items);
    expect(json).not.toMatch(/score|points|breakdown|private notes|userId/i);
  });

  it("loading Focus writes nothing, and no ranking column or table exists", async () => {
    await createTask(me, { priority: "HIGH", deadlineDate: "2026-11-09" });
    await createTask(me, { priority: "LOW", createdAt: new Date("2026-08-01T00:00:00Z") });
    const snapshot = async () => JSON.stringify(await prisma.task.findMany({ orderBy: { id: "asc" } }));
    const before = await snapshot();
    await focus();
    await focus();
    expect(await snapshot()).toBe(before);
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`select column_name from information_schema.columns where table_schema = 'public' and (column_name ilike '%score%' or column_name ilike '%rank%' or column_name ilike '%focus%')`;
    expect(columns).toEqual([]);
  });
});

describe("the rest of the dashboard is unchanged", () => {
  it("the sections, counts and briefing are exactly what they were (Focus is only added)", async () => {
    await createTask(me, { title: "overdue", deadlineDate: "2026-11-09" });
    await createTask(me, { title: "today", deadlineDate: "2026-11-10" });
    await createTask(me, { title: "upcoming", deadlineDate: "2026-11-14" });
    await createTask(me, { title: "later", deadlineDate: "2026-12-30" });
    await createTask(me, { title: "none" });
    await createTask(me, { title: "done today", status: "COMPLETED", completedAt: NOW });
    const data = await loadDashboard({ userId: me, name: null, timeZone: "Europe/Tallinn", now: NOW });
    expect(data.counts).toEqual({ overdue: 1, today: 1, upcoming: 1, later: 1, none: 1 });
    expect(data.briefing).toEqual({ dueToday: 1, overdue: 1, completedToday: 1 });
    expect(titles(data.sections.overdue)).toEqual(["overdue"]);
    expect(titles(data.sections.today)).toEqual(["today"]);
    expect(data.focus).toHaveLength(5); // five of the five open tasks
  });
});
