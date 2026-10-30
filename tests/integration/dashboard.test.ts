// Stage 5: the dashboard's data, against the separate test database. loadDashboard takes a fixed
// clock; the Tasks-page filter and the page-level loader are tested with a chosen session.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: { id: "", name: "Edvin Pasun", email: "t@example.invalid", timeZone: "Europe/Tallinn" } }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => session.user,
  getCurrentUser: async () => session.user,
}));

import { DUE_SECTIONS } from "@/lib/dashboard/sections";
import { getMyDashboard, loadDashboard, SECTION_LIMIT } from "@/lib/dashboard/queries";
import { nowInTimeZone } from "@/lib/local-time";
import { addDays } from "@/lib/recurrence/civil-date";
import { completeTask, pauseSeries } from "@/lib/recurrence/service";
import { getMyTasks } from "@/lib/tasks";
import { archiveTask, trashTask } from "@/lib/trash/service";

import { at, createCategory, createTask, createUser, ctxFor, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring } from "../helpers/recurrence";

let userId: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser("me");
  other = await createUser("other");
  session.user.id = userId;
  session.user.timeZone = "Europe/Tallinn";
});
afterAll(() => prisma.$disconnect());

const NOW = at("2026-11-10", "14:30"); // Tuesday
const load = (now: Date = NOW, user = userId, timeZone = "Europe/Tallinn") => loadDashboard({ userId: user, name: "Edvin Pasun", timeZone, now });
const ids = (tasks: Array<{ id: string }>) => tasks.map((t) => t.id);

describe("sections and counts", () => {
  it("puts each unfinished task in exactly one section, with the briefing numbers", async () => {
    const overdue = await createTask(userId, { title: "overdue", deadlineDate: "2026-11-09" });
    const overdueToday = await createTask(userId, { title: "overdue by time", deadlineDate: "2026-11-10", deadlineTime: "09:00" });
    const today = await createTask(userId, { title: "today", deadlineDate: "2026-11-10", deadlineTime: "18:00" });
    const todayDateOnly = await createTask(userId, { title: "today date-only", deadlineDate: "2026-11-10" });
    const upcoming = await createTask(userId, { title: "upcoming", deadlineDate: "2026-11-17" });
    const later = await createTask(userId, { title: "later", deadlineDate: "2026-11-18" });
    const none = await createTask(userId, { title: "none", plannedDate: "2026-11-10" }); // planned only: no due date
    const done = await createTask(userId, { title: "done", status: "COMPLETED", deadlineDate: "2026-11-10" });

    const data = await load();
    expect(ids(data.sections.overdue)).toEqual([overdue.id, overdueToday.id]);
    expect(ids(data.sections.today)).toEqual([today.id, todayDateOnly.id]);
    expect(ids(data.sections.upcoming)).toEqual([upcoming.id]);
    expect(ids(data.sections.none)).toEqual([none.id]);
    expect(data.counts).toEqual({ overdue: 2, today: 2, upcoming: 1, later: 1, none: 1 });
    expect(data.briefing).toMatchObject({ dueToday: 2, overdue: 2 });

    const shown = [...data.sections.overdue, ...data.sections.today, ...data.sections.upcoming, ...data.sections.none].map((t) => t.id);
    expect(new Set(shown).size).toBe(shown.length); // never in two sections
    expect([...shown, later.id, done.id]).not.toContain(undefined);
    expect(shown).not.toContain(later.id); // later is only a count
    expect(shown).not.toContain(done.id);
  });

  it("shows at most 5 per section but counts them all", async () => {
    for (let i = 0; i < 8; i++) await createTask(userId, { title: `o${i}`, deadlineDate: `2026-11-0${i + 1}` });
    for (let i = 0; i < 7; i++) await createTask(userId, { title: `n${i}`, createdAt: new Date(Date.UTC(2026, 9, 1 + i)) });
    const data = await load();
    expect(data.sections.overdue).toHaveLength(SECTION_LIMIT);
    expect(data.counts.overdue).toBe(8);
    expect(data.briefing.overdue).toBe(8);
    expect(data.sections.none).toHaveLength(SECTION_LIMIT);
    expect(data.counts.none).toBe(7);
    // The five shown are the first five by the section's order (the oldest deadlines).
    expect(data.sections.overdue.map((t) => t.deadlineDate)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
  });

  it("an empty dashboard has zero counts and no sections", async () => {
    const data = await load();
    expect(data.counts).toEqual({ overdue: 0, today: 0, upcoming: 0, later: 0, none: 0 });
    expect(data.briefing).toEqual({ dueToday: 0, overdue: 0, completedToday: 0 });
    expect(data.greeting).toBe("Good afternoon, Edvin");
    expect(data.today).toBe("2026-11-10");
  });

  it("a task moves between sections as time passes", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10", deadlineTime: "15:00" });
    expect(ids((await load(at("2026-11-10", "14:59"))).sections.today)).toEqual([task.id]);
    expect(ids((await load(at("2026-11-10", "15:00"))).sections.today)).toEqual([task.id]); // overdue only once passed
    expect(ids((await load(at("2026-11-10", "15:01"))).sections.overdue)).toEqual([task.id]);
    const dateOnly = await createTask(userId, { deadlineDate: "2026-11-10" });
    expect(ids((await load(at("2026-11-10", "23:59"))).sections.today)).toContain(dateOnly.id);
    expect(ids((await load(at("2026-11-11", "00:00"))).sections.overdue)).toContain(dateOnly.id);
  });

  it("upcoming is the next 7 calendar days, later starts on the 8th, also across the clock change", async () => {
    const seventh = await createTask(userId, { deadlineDate: "2026-03-29" });
    const eighth = await createTask(userId, { deadlineDate: "2026-03-30" });
    const data = await load(at("2026-03-22", "12:00"));
    expect(ids(data.sections.upcoming)).toEqual([seventh.id]);
    expect(data.counts.later).toBe(1);
    expect(eighth.id).toBeTruthy();
  });

  it("includes the category, so the existing category display works", async () => {
    const category = await createCategory(userId, "Work");
    await createTask(userId, { title: "c", categoryId: category.id });
    expect((await load()).sections.none[0].category?.name).toBe("Work");
  });
});

describe("what the dashboard excludes", () => {
  it("trashed, archived and completed tasks are not in any section or count", async () => {
    const trashed = await createTask(userId, { deadlineDate: "2026-11-10" });
    const archived = await createTask(userId, { status: "COMPLETED", deadlineDate: "2026-11-10" });
    await createTask(userId, { status: "COMPLETED", deadlineDate: "2026-11-10" });
    await trashTask(ctxFor(userId), trashed.id);
    await archiveTask(ctxFor(userId), archived.id);
    const data = await load();
    expect(data.counts).toEqual({ overdue: 0, today: 0, upcoming: 0, later: 0, none: 0 });
  });

  it("another user's tasks never appear or count", async () => {
    await createTask(other, { deadlineDate: "2026-11-09" });
    await createTask(other, { deadlineDate: "2026-11-10" });
    await createTask(other, { status: "COMPLETED", completedAt: at("2026-11-10", "10:00") });
    const data = await load();
    expect(data.counts.overdue + data.counts.today + data.counts.none).toBe(0);
    expect(data.briefing.completedToday).toBe(0);
    expect((await load(NOW, other)).counts.overdue).toBe(1);
  });
});

describe("completed today", () => {
  const completed = (completedAt: Date, extra: { archived?: boolean } = {}) =>
    createTask(userId, { status: "COMPLETED", completedAt }).then(async (task) => {
      if (extra.archived) await prisma.task.update({ where: { id: task.id }, data: { archivedAt: new Date() } });
      return task;
    });

  it("counts exactly the current local day: the first and last millisecond are in, the neighbours are out", async () => {
    await completed(new Date("2026-11-09T21:59:59.999Z")); // 23:59:59.999 on the 9th (EET)
    await completed(new Date("2026-11-09T22:00:00.000Z")); // 00:00:00 on the 10th: in
    await completed(new Date("2026-11-10T12:00:00.000Z")); // midday: in
    await completed(new Date("2026-11-10T21:59:59.999Z")); // 23:59:59.999 on the 10th: in
    await completed(new Date("2026-11-10T22:00:00.000Z")); // 00:00 on the 11th: out
    expect((await load()).briefing.completedToday).toBe(3);
  });

  it("measures the 23-hour day when the clocks go forward (2026-03-29)", async () => {
    await completed(new Date("2026-03-28T21:59:59.999Z")); // the 28th: out
    await completed(new Date("2026-03-28T22:00:00.000Z")); // 00:00 EET on the 29th: in
    await completed(new Date("2026-03-29T20:59:59.999Z")); // 23:59:59 EEST on the 29th: in
    await completed(new Date("2026-03-29T21:00:00.000Z")); // 00:00 on the 30th: out
    expect((await load(at("2026-03-29", "12:00"))).briefing.completedToday).toBe(2);
  });

  it("measures the 25-hour day when the clocks go back (2026-10-25)", async () => {
    await completed(new Date("2026-10-24T20:59:59.999Z")); // the 24th: out
    await completed(new Date("2026-10-24T21:00:00.000Z")); // 00:00 EEST on the 25th: in
    await completed(new Date("2026-10-25T01:30:00.000Z")); // the repeated hour: in
    await completed(new Date("2026-10-25T21:59:59.999Z")); // 23:59:59 EET on the 25th: in
    await completed(new Date("2026-10-25T22:00:00.000Z")); // the 26th: out
    expect((await load(at("2026-10-25", "12:00"))).briefing.completedToday).toBe(3);
  });

  it("uses the user's saved time zone for 'today'", async () => {
    await completed(new Date("2026-11-10T03:00:00Z")); // 22:00 on the 9th in New York, 05:00 on the 10th in Tallinn
    const now = new Date("2026-11-10T15:00:00Z");
    expect((await load(now, userId, "Europe/Tallinn")).briefing.completedToday).toBe(1);
    expect((await load(now, userId, "America/New_York")).briefing.completedToday).toBe(0);
    expect((await load(now, userId, "America/New_York")).today).toBe("2026-11-10");
  });

  it("includes archived tasks, excludes tasks in Trash, and a reopened task stops counting", async () => {
    await completed(at("2026-11-10", "09:00"));
    await completed(at("2026-11-10", "09:30"), { archived: true });
    const trashed = await completed(at("2026-11-10", "10:00"));
    const reopened = await completed(at("2026-11-10", "10:30"));
    await trashTask(ctxFor(userId), trashed.id);
    expect((await load()).briefing.completedToday).toBe(3);
    await prisma.task.update({ where: { id: reopened.id }, data: { status: "TODO", completedAt: null } });
    expect((await load()).briefing.completedToday).toBe(2);
  });

  it("counts each completed occurrence of a recurring task separately, and shows only the open one", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "DAILY", plannedDate: "2026-11-10", deadlineDate: "2026-11-10" });
    const first = await completeTask(ctxFor(userId, "2026-11-10", "10:00"), task.id);
    expect(first.ok).toBe(true);
    const next = (await prisma.task.findFirstOrThrow({ where: { seriesId, status: { not: "COMPLETED" } } })).id;
    await completeTask(ctxFor(userId, "2026-11-10", "11:00"), next);
    const data = await load(at("2026-11-10", "12:00"));
    expect(data.briefing.completedToday).toBe(2);
    // One open occurrence is left (the next day's); future occurrences are not invented.
    expect(data.counts.today + data.counts.overdue + data.counts.upcoming + data.counts.none + data.counts.later).toBe(1);
  });
});

describe("recurring tasks", () => {
  it("a series contributes only its open occurrence, once", async () => {
    await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-09", deadlineDate: "2026-11-11", title: "Weekly" });
    const data = await load();
    expect(data.counts.upcoming).toBe(1);
    expect(data.sections.upcoming[0].repeat).toEqual({ state: "ACTIVE" });
  });

  it("a paused series' open task is still shown, with its state", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-09", deadlineDate: "2026-11-11" });
    await pauseSeries(ctxFor(userId), seriesId, 1, null);
    expect((await load()).sections.upcoming[0].repeat).toEqual({ state: "PAUSED" });
  });

  it("an overdue occurrence is one overdue task (no backlog is invented)", async () => {
    await makeRecurring(userId, { type: "DAILY", plannedDate: "2026-11-01", deadlineDate: "2026-11-01" });
    const data = await load();
    expect(data.counts.overdue).toBe(1);
    expect(data.counts.today + data.counts.upcoming).toBe(0);
  });
});

describe("the Tasks page filter and the page-level loader (real clock)", () => {
  const today = () => nowInTimeZone("Europe/Tallinn").date;

  async function seedAroundToday() {
    const t = today();
    await createTask(userId, { title: "overdue", deadlineDate: addDays(t, -3) });
    await createTask(userId, { title: "today", deadlineDate: t });
    await createTask(userId, { title: "upcoming", deadlineDate: addDays(t, 3) });
    await createTask(userId, { title: "later", deadlineDate: addDays(t, 20) });
    await createTask(userId, { title: "none" });
    await createTask(userId, { title: "done", status: "COMPLETED", deadlineDate: t });
    const trashed = await createTask(userId, { title: "trashed", deadlineDate: addDays(t, -1) });
    await trashTask(ctxFor(userId), trashed.id);
  }

  it("every due filter returns exactly the tasks the dashboard counted for that section", async () => {
    await seedAroundToday();
    const data = await getMyDashboard();
    for (const section of DUE_SECTIONS) {
      const listed = await getMyTasks(undefined, section);
      expect(listed.length, section).toBe(data.counts[section]);
      expect(listed.every((t) => t.status !== "COMPLETED"), section).toBe(true);
    }
    expect((await getMyTasks(undefined, "overdue")).map((t) => t.title)).toEqual(["overdue"]);
    expect((await getMyTasks(undefined, "later")).map((t) => t.title)).toEqual(["later"]);
    // A task is in exactly one filter.
    const all = (await Promise.all(DUE_SECTIONS.map((s) => getMyTasks(undefined, s)))).flat().map((t) => t.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("View all lists the same tasks, in the same order, as the dashboard's first five", async () => {
    const t = today();
    for (let i = 0; i < 7; i++) await createTask(userId, { title: `o${i}`, deadlineDate: addDays(t, -(10 - i)) });
    const data = await getMyDashboard();
    const all = await getMyTasks(undefined, "overdue");
    expect(all).toHaveLength(7);
    expect(ids(all).slice(0, SECTION_LIMIT)).toEqual(ids(data.sections.overdue));
  });

  it("the due filter combines with the category filter, and without a filter nothing changes", async () => {
    const t = today();
    const work = await createCategory(userId, "Work");
    await createTask(userId, { title: "work overdue", deadlineDate: addDays(t, -1), categoryId: work.id });
    await createTask(userId, { title: "other overdue", deadlineDate: addDays(t, -1) });
    await createTask(userId, { title: "work done", status: "COMPLETED", categoryId: work.id });
    expect((await getMyTasks(work.id, "overdue")).map((x) => x.title)).toEqual(["work overdue"]);
    expect((await getMyTasks(work.id)).map((x) => x.title).sort()).toEqual(["work done", "work overdue"]);
    expect(await getMyTasks()).toHaveLength(3);
  });

  it("getMyDashboard uses the saved time zone of the user", async () => {
    session.user.timeZone = "Pacific/Auckland";
    const data = await getMyDashboard();
    expect(data.today).toBe(nowInTimeZone("Pacific/Auckland").date);
  });
});
