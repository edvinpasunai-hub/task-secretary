import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dateFromDb } from "@/lib/local-time";
import { convertToRecurring, getSeries } from "@/lib/recurrence/service";

import { createCategory, createTask, createUser, ctxFor, instancesOf, keysOf, prisma, resetDatabase } from "../helpers/db";
import { complete as completeFor, dates, makeRecurring, undo, type Setup } from "../helpers/recurrence";

// 2026: Mon 2 / 9 / 16 / 23 / 30 Nov, Mon 7 Dec.  Sun 29 Mar and Sun 25 Oct are Tallinn's DST days.

let userId: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser();
});
afterAll(() => prisma.$disconnect());

const recurring = (options: Setup & { owner?: string } = { type: "WEEKLY" }) => makeRecurring(options.owner ?? userId, options);
const complete = (taskId: string, date: string, time = "12:00") => completeFor(userId, taskId, date, time);

describe("converting an ordinary task into a recurring one", () => {
  it("keeps the same task (id, status, details, history) and creates the series", async () => {
    const category = await createCategory(userId);
    const task = await createTask(userId, {
      title: "Weekly report", description: "Write it", status: "IN_PROGRESS", priority: "HIGH", estimatedMinutes: 90, categoryId: category.id,
      plannedDate: "2026-11-02", deadlineDate: "2026-11-05", deadlineTime: "17:00", rescheduleCount: 2,
    });
    const result = await convertToRecurring(ctxFor(userId), task.id, { type: "WEEKLY" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.id).toBe(task.id);
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.rescheduleCount).toBe(2);
    expect(dates(after)).toEqual(dates(task));
    expect([after.title, after.description, after.priority, after.estimatedMinutes, after.categoryId]).toEqual(["Weekly report", "Write it", "HIGH", 90, category.id]);
    expect(after.seriesId).toBe(result.value.seriesId);
    expect(after.occurrenceKey).toBe("2026-11-02");
    expect(await prisma.task.count({ where: { userId } })).toBe(1); // no duplicate task
    expect(result.value.successor).toBeNull(); // unfinished: its successor comes when it is completed

    const series = (await getSeries(ctxFor(userId), result.value.seriesId))!;
    expect(series).toMatchObject({ type: "WEEKLY", weekdays: [1], anchorDate: "2026-11-02", plannedTime: null, title: "Weekly report", description: "Write it", priority: "HIGH", estimatedMinutes: 90, categoryId: category.id, deadlineOffsetDays: 3, deadlineTime: "17:00", endDate: null, state: "ACTIVE", pausedUntil: null, version: 1 });
  });

  it("converting an already completed task also creates the next instance", async () => {
    const task = await createTask(userId, { status: "COMPLETED", plannedDate: "2026-11-02" });
    const result = await convertToRecurring(ctxFor(userId, "2026-11-04"), task.id, { type: "WEEKLY" });
    expect(result.ok && result.value.successor?.occurrenceKey).toBe("2026-11-09");
    const [first, second] = await instancesOf(result.ok ? result.value.seriesId : "");
    expect(first.id).toBe(task.id);
    expect(first.status).toBe("COMPLETED");
    expect([second.status, second.predecessorId]).toEqual(["TODO", task.id]);
  });

  it("weekly and monthly adopt the planned date's weekday and day of the month; timed tasks make timed series", async () => {
    const w = await recurring({ type: "WEEKLY", plannedDate: "2026-11-04" }); // Wednesday
    expect((await getSeries(ctxFor(userId), w.seriesId))!.weekdays).toEqual([3]);
    const m = await recurring({ type: "MONTHLY", plannedDate: "2026-01-31" });
    expect((await getSeries(ctxFor(userId), m.seriesId))!.monthlyDay).toBe(31);
    const t = await recurring({ type: "DAILY", plannedDate: "2026-11-02", plannedTime: "09:00" });
    expect((await getSeries(ctxFor(userId), t.seriesId))!.plannedTime).toBe("09:00");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.task.id } })).occurrenceKey).toBe("2026-11-02T09:00");
  });

  it("is refused when it cannot be valid, and changes nothing", async () => {
    const noDate = await createTask(userId, { plannedDate: null });
    const r1 = await convertToRecurring(ctxFor(userId), noDate.id, { type: "DAILY" });
    expect(r1).toMatchObject({ ok: false, error: { code: "VALIDATION" } });

    const tuesday = await createTask(userId, { plannedDate: "2026-11-03" });
    const r2 = await convertToRecurring(ctxFor(userId), tuesday.id, { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5] });
    expect(r2.ok === false && r2.error.issues?.map((i) => i.code)).toContain("ANCHOR_NOT_ON_SCHEDULE");

    const r3 = await convertToRecurring(ctxFor(userId), tuesday.id, { type: "CUSTOM_WEEKDAYS", weekdays: [] });
    expect(r3).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const r4 = await convertToRecurring(ctxFor(userId), tuesday.id, { type: "DAILY", endDate: "2026-11-01" });
    expect(r4).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const r5 = await convertToRecurring(ctxFor(userId), tuesday.id, { type: "YEARLY" as never });
    expect(r5).toMatchObject({ ok: false, error: { code: "VALIDATION" } });

    expect(await prisma.recurringSeries.count()).toBe(0);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tuesday.id } })).seriesId).toBeNull();
  });

  it("refuses a task that already repeats", async () => {
    const { task } = await recurring({ type: "DAILY" });
    expect(await convertToRecurring(ctxFor(userId), task.id, { type: "DAILY" })).toMatchObject({ ok: false, error: { code: "ALREADY_RECURRING" } });
    expect(await prisma.recurringSeries.count()).toBe(1);
  });
});

describe("completing a recurring task creates exactly one successor on the fixed schedule", () => {
  it("copies the template, resets instance state, and keeps the deadline offset", async () => {
    const category = await createCategory(userId);
    const { task, seriesId } = await recurring({
      type: "WEEKLY", title: "Report", description: "Details", priority: "HIGH", estimatedMinutes: 45, categoryId: category.id,
      plannedDate: "2026-11-02", plannedTime: "09:00", deadlineDate: "2026-11-05", deadlineTime: "17:00",
    });
    // changes made to ONE instance ("only this task") must not be copied forward
    await prisma.task.update({ where: { id: task.id }, data: { title: "Edited just here", description: "Only here", rescheduleCount: 4, priority: "LOW" } });

    const outcome = await complete(task.id, "2026-11-05", "10:00"); // completed on Thursday
    expect(outcome).toMatchObject({ alreadyCompleted: false, successor: { occurrenceKey: "2026-11-09T09:00" } });

    const [first, second] = await instancesOf(seriesId);
    expect(first).toMatchObject({ id: task.id, status: "COMPLETED", title: "Edited just here" });
    expect(first.completedAt).not.toBeNull();
    expect(second).toMatchObject({
      title: "Report", description: "Details", priority: "HIGH", estimatedMinutes: 45, categoryId: category.id,
      status: "TODO", completedAt: null, rescheduleCount: 0, predecessorId: task.id, userId, seriesId,
    });
    expect(dates(second)).toEqual({ planned: ["2026-11-09", "09:00"], deadline: ["2026-11-12", "17:00"], original: "2026-11-12" });
  });

  it("the schedule is fixed: a Monday task done on Thursday gets the next Monday, not +7 days", async () => {
    const { task, seriesId } = await recurring({ type: "WEEKLY" });
    await complete(task.id, "2026-11-05");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("missed occurrences are skipped, never queued (done three weeks late)", async () => {
    const { task, seriesId } = await recurring({ type: "WEEKLY" });
    await complete(task.id, "2026-11-25");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-30"]);
  });

  it("an overdue unfinished instance is left exactly as it is", async () => {
    const { task, seriesId } = await recurring({ type: "WEEKLY", deadlineDate: "2026-11-03" });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    await getSeries(ctxFor(userId, "2026-11-20"), seriesId); // any later activity
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after).toEqual(before);
  });

  it("early completion creates the next instance immediately, and completing future instances early keeps advancing", async () => {
    const { task, seriesId } = await recurring({ type: "WEEKLY", plannedDate: "2026-11-02" });
    const second = (await complete(task.id, "2026-11-02")).successor!; // done on the day: next is 9 Nov
    expect(second.occurrenceKey).toBe("2026-11-09");
    const third = (await complete(second.id, "2026-11-03")).successor!; // 9 Nov instance done a week early
    const fourth = (await complete(third.id, "2026-11-03")).successor!; // and the next one too
    expect([third.occurrenceKey, fourth.occurrenceKey]).toEqual(["2026-11-16", "2026-11-23"]);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]); // never a repeat
  });

  it("date-only: completing on the day of the next occurrence picks a LATER date", async () => {
    const { task } = await recurring({ type: "WEEKLY" });
    expect((await complete(task.id, "2026-11-09")).successor?.occurrenceKey).toBe("2026-11-16");
  });

  it("timed: a later time on the same day is chosen", async () => {
    const { task } = await recurring({ type: "DAILY", plannedDate: "2026-11-08", plannedTime: "18:00" });
    expect((await complete(task.id, "2026-11-09", "07:00")).successor?.occurrenceKey).toBe("2026-11-09T18:00");
    const other = await recurring({ type: "DAILY", plannedDate: "2026-11-08", plannedTime: "18:00" });
    expect((await complete(other.task.id, "2026-11-09", "19:00")).successor?.occurrenceKey).toBe("2026-11-10T18:00");
  });

  it("monthly keeps the original day (Jan 31 → Feb 28 → Mar 31 → Apr 30)", async () => {
    const { task, seriesId } = await recurring({ type: "MONTHLY", plannedDate: "2026-01-31" });
    let current = task.id;
    for (const when of ["2026-01-31", "2026-02-28", "2026-03-31"]) current = (await complete(current, when)).successor!.id;
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("monthly in a leap year uses Feb 29", async () => {
    const { task } = await recurring({ type: "MONTHLY", plannedDate: "2028-01-31" });
    expect((await complete(task.id, "2028-01-31")).successor?.occurrenceKey).toBe("2028-02-29");
  });

  it("custom weekdays walk Mon → Wed → Fri → Mon and cross the year boundary", async () => {
    const { task, seriesId } = await recurring({ type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5] });
    let current = task.id;
    for (const when of ["2026-11-02", "2026-11-04", "2026-11-06"]) current = (await complete(current, when)).successor!.id;
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-09"]);

    const year = await recurring({ type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5], plannedDate: "2026-12-30" });
    const next = (await complete(year.task.id, "2026-12-30")).successor!;
    expect(next.occurrenceKey).toBe("2027-01-01"); // Thursday 31 Dec is not selected
  });

  it("daily crosses month, year and the leap day", async () => {
    const { task } = await recurring({ type: "DAILY", plannedDate: "2028-02-28" });
    const feb29 = (await complete(task.id, "2028-02-28")).successor!;
    expect(feb29.occurrenceKey).toBe("2028-02-29");
    expect((await complete(feb29.id, "2028-02-29")).successor?.occurrenceKey).toBe("2028-03-01");
  });

  it("timed series keep their wall-clock time across the spring and autumn clock changes", async () => {
    const spring = await recurring({ type: "WEEKLY", plannedDate: "2026-03-22", plannedTime: "03:30" }); // Sunday
    const march29 = (await complete(spring.task.id, "2026-03-22", "04:00")).successor!;
    expect(march29.occurrenceKey).toBe("2026-03-29T03:30"); // 03:30 does not exist that day; the key and stored time stay 03:30
    const row = await prisma.task.findUniqueOrThrow({ where: { id: march29.id } });
    expect(dates(row).planned).toEqual(["2026-03-29", "03:30"]);
    expect((await complete(march29.id, "2026-03-29", "05:00")).successor?.occurrenceKey).toBe("2026-04-05T03:30");

    const autumn = await recurring({ type: "DAILY", plannedDate: "2026-10-24", plannedTime: "03:30" });
    const oct25 = (await complete(autumn.task.id, "2026-10-24", "04:00")).successor!;
    expect(oct25.occurrenceKey).toBe("2026-10-25T03:30"); // happens twice that night; still one occurrence
    expect((await complete(oct25.id, "2026-10-25", "03:45")).successor?.occurrenceKey).toBe("2026-10-26T03:30");
  });

  it("deadline offsets: none, date-only, timed, cross-day and across a clamped month", async () => {
    const none = await recurring({ type: "WEEKLY" });
    const noneNext = await prisma.task.findUniqueOrThrow({ where: { id: (await complete(none.task.id, "2026-11-02")).successor!.id } });
    expect(dates(noneNext).deadline).toEqual([null, null]);

    const sameDay = await recurring({ type: "WEEKLY", deadlineDate: "2026-11-02", deadlineTime: "17:00", plannedTime: "09:00" });
    const sameNext = await prisma.task.findUniqueOrThrow({ where: { id: (await complete(sameDay.task.id, "2026-11-02", "10:00")).successor!.id } });
    expect(dates(sameNext)).toEqual({ planned: ["2026-11-09", "09:00"], deadline: ["2026-11-09", "17:00"], original: "2026-11-09" });

    const monthly = await recurring({ type: "MONTHLY", plannedDate: "2026-01-31", deadlineDate: "2026-02-03" });
    const feb = await prisma.task.findUniqueOrThrow({ where: { id: (await complete(monthly.task.id, "2026-01-31")).successor!.id } });
    expect(dates(feb)).toEqual({ planned: ["2026-02-28", null], deadline: ["2026-03-03", null], original: "2026-03-03" }); // 28 Feb + 3 days

    const dst = await recurring({ type: "DAILY", plannedDate: "2026-03-28", plannedTime: "22:00", deadlineDate: "2026-03-30", deadlineTime: "03:30" });
    const next = await prisma.task.findUniqueOrThrow({ where: { id: (await complete(dst.task.id, "2026-03-28", "23:00")).successor!.id } });
    expect(dates(next)).toEqual({ planned: ["2026-03-29", "22:00"], deadline: ["2026-03-31", "03:30"], original: "2026-03-31" }); // 2 calendar days, wall-clock time kept
  });

  it("a postponed instance does not move the schedule", async () => {
    const { task, seriesId } = await recurring({ type: "WEEKLY" });
    await prisma.task.update({ where: { id: task.id }, data: { plannedDate: new Date("2026-11-04T00:00:00Z") } }); // postponed by hand
    const outcome = await complete(task.id, "2026-11-04");
    expect(outcome.successor?.occurrenceKey).toBe("2026-11-09");
    const first = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect([first.occurrenceKey, dateFromDb(first.plannedDate)]).toEqual(["2026-11-02", "2026-11-04"]); // scheduled occurrence and manual date stay distinct
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("a second completion request is harmless and reports it", async () => {
    const { task, seriesId } = await recurring({ type: "WEEKLY" });
    const first = await complete(task.id, "2026-11-02");
    const again = await complete(task.id, "2026-11-03");
    expect(again).toMatchObject({ alreadyCompleted: true, successor: { id: first.successor!.id } });
    expect(await prisma.task.count({ where: { seriesId } })).toBe(2);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).toEqual(ctxFor(userId, "2026-11-02").now); // first timestamp kept
  });

  it("an ordinary (non-recurring) task is simply completed", async () => {
    const task = await createTask(userId);
    expect(await complete(task.id, "2026-11-02")).toMatchObject({ alreadyCompleted: false, successor: null, seriesState: null });
    expect(await prisma.task.count()).toBe(1);
  });
});

describe("Undo Complete and several unfinished instances", () => {
  it("re-completing a reverted instance creates no second successor; multiple unfinished instances coexist", async () => {
    const { task: a, seriesId } = await recurring({ type: "WEEKLY" });
    const b = (await complete(a.id, "2026-11-02")).successor!;
    await undo(a.id); // A is unfinished again while B (its successor) exists
    expect((await instancesOf(seriesId)).filter((t) => t.status !== "COMPLETED").map((t) => t.occurrenceKey)).toEqual(["2026-11-02", "2026-11-09"]);

    const recompleted = await complete(a.id, "2026-11-20"); // long after: still nothing new
    expect(recompleted).toMatchObject({ alreadyCompleted: false, successor: null });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);

    const c = (await complete(b.id, "2026-11-05")).successor!; // the tail continues the series
    expect(c.occurrenceKey).toBe("2026-11-16");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });

  it("reverting the tail whose successor exists, then completing it again, creates nothing", async () => {
    const { task: a, seriesId } = await recurring({ type: "WEEKLY" });
    const b = (await complete(a.id, "2026-11-02")).successor!;
    const c = (await complete(b.id, "2026-11-09")).successor!;
    await undo(b.id);
    expect((await complete(b.id, "2026-11-10")).successor).toBeNull();
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", c.occurrenceKey]);
  });

  it("never regenerates an older occurrence nor skips the next valid one", async () => {
    const { task: a, seriesId } = await recurring({ type: "WEEKLY" });
    const b = (await complete(a.id, "2026-11-02")).successor!;
    const c = (await complete(b.id, "2026-11-09")).successor!;
    await undo(a.id);
    await undo(b.id);
    await complete(a.id, "2026-11-23");
    await complete(b.id, "2026-11-23");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]); // still exactly one future instance, c
    const d = (await complete(c.id, "2026-11-12")).successor!; // c done early: next is the one after c
    expect(d.occurrenceKey).toBe("2026-11-23");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
  });

  it("every instance stays linked to its predecessor and to the same series and user", async () => {
    const { task: a, seriesId } = await recurring({ type: "DAILY" });
    const b = (await complete(a.id, "2026-11-02")).successor!;
    const c = (await complete(b.id, "2026-11-03")).successor!;
    const rows = await instancesOf(seriesId);
    expect(rows.map((r) => r.predecessorId)).toEqual([null, a.id, b.id]);
    expect(rows.every((r) => r.userId === userId && r.seriesId === seriesId)).toBe(true);
    expect(c.occurrenceKey).toBe("2026-11-04");
  });
});
