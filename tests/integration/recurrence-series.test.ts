import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dateFromDb } from "@/lib/local-time";
import {
  completeTask,
  convertToRecurring,
  disableRecurrence,
  getSeries,
  getSeriesForecast,
  pauseSeries,
  reconcileExpiredPauses,
  resetReconcileBackoff,
  resumeSeries,
  setSeriesEndDate,
  stopSeries,
  updateSeries,
} from "@/lib/recurrence/service";

import { createCategory, createTask, createUser, ctxFor, instancesOf, keysOf, prisma, resetDatabase } from "../helpers/db";
import { complete, dates, makeRecurring, seriesRow, taskRow, undo } from "../helpers/recurrence";

// 2026: Mon 2 / 9 / 16 / 23 / 30 Nov, Mon 7 Dec. Tue 24 Nov.

let userId: string;
beforeEach(async () => {
  await resetDatabase();
  resetReconcileBackoff();
  userId = await createUser();
});
afterAll(() => prisma.$disconnect());

const ctx = (date: string, time = "12:00") => ctxFor(userId, date, time);
const view = async (seriesId: string) => (await getSeries(ctx("2026-11-02"), seriesId))!;
const okValue = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.error)}`);
  return result.value as T;
};

describe("pause and resume", () => {
  it("completing the tail while paused creates nothing; resuming creates the nearest FUTURE occurrence, with no backlog or duplicate", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    const paused = okValue(await pauseSeries(ctx("2026-11-12"), seriesId, 1, null));
    expect(paused).toMatchObject({ state: "PAUSED", pausedUntil: null, version: 2 });

    const done = await complete(userId, a.id, "2026-11-16");
    expect(done).toMatchObject({ successor: null, seriesState: "PAUSED", alreadyCompleted: false });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16"]);

    // Resumed on Tuesday 24 Nov: Monday 23 Nov was missed and is skipped; next is Monday 30 Nov.
    const resumed = okValue(await resumeSeries(ctx("2026-11-24", "10:00"), seriesId, 2));
    expect(resumed.created?.occurrenceKey).toBe("2026-11-30");
    expect(resumed.series).toMatchObject({ state: "ACTIVE", pausedUntil: null, version: 3 });
    const rows = await instancesOf(seriesId);
    expect(keysOf(rows)).toEqual(["2026-11-16", "2026-11-30"]);
    expect(rows[1]).toMatchObject({ status: "TODO", predecessorId: a.id });

    // Undo + re-complete of the old instance must not add another one.
    await undo(a.id);
    expect((await complete(userId, a.id, "2026-12-01")).successor).toBeNull();
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-11-30"]);
  });

  it("resuming while the tail is still unfinished creates nothing; the tail's completion continues the series", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx("2026-11-12"), seriesId, 1));
    const resumed = okValue(await resumeSeries(ctx("2026-11-24"), seriesId, 2));
    expect(resumed.created).toBeNull();
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16"]);
    expect((await complete(userId, a.id, "2026-11-25")).successor?.occurrenceKey).toBe("2026-11-30");
  });

  it("an unfinished instance stays visible and actionable while the series is paused", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    okValue(await pauseSeries(ctx("2026-11-02"), seriesId, 1));
    await prisma.task.update({ where: { id: task.id }, data: { title: "Still editable", status: "IN_PROGRESS" } });
    const row = await taskRow(task.id);
    expect([row.title, row.status, row.seriesId]).toEqual(["Still editable", "IN_PROGRESS", seriesId]);
    expect((await complete(userId, task.id, "2026-11-03")).successor).toBeNull(); // and completable
  });

  it("'paused until a date' is reconciled when the date comes, once, without a backlog", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-11-24"));
    await complete(userId, a.id, "2026-11-16");

    expect(await reconcileExpiredPauses(ctx("2026-11-20"))).toMatchObject({ reconciled: 0, failed: [] });
    expect((await view(seriesId)).state).toBe("PAUSED"); // not yet

    expect(await reconcileExpiredPauses(ctx("2026-11-24", "00:00"))).toMatchObject({ reconciled: 1, failed: [] });
    expect(await view(seriesId)).toMatchObject({ state: "ACTIVE", pausedUntil: null, version: 3 });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-11-30"]);

    for (let i = 0; i < 3; i++) expect(await reconcileExpiredPauses(ctx("2026-11-25"))).toMatchObject({ reconciled: 0 }); // repeated: nothing more
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-11-30"]);
    expect((await view(seriesId)).version).toBe(3);
  });

  it("reconciling only touches the logged-in user's series", async () => {
    const other = await createUser("other");
    const mine = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    const theirs = await makeRecurring(other, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx("2026-11-12"), mine.seriesId, 1, "2026-11-20"));
    okValue(await pauseSeries(ctxFor(other, "2026-11-12"), theirs.seriesId, 1, "2026-11-20"));
    await prisma.task.updateMany({ where: { seriesId: { in: [mine.seriesId, theirs.seriesId] } }, data: { status: "COMPLETED", completedAt: new Date() } });

    expect(await reconcileExpiredPauses(ctx("2026-11-21"))).toMatchObject({ reconciled: 1 });
    expect((await seriesRow(mine.seriesId)).state).toBe("ACTIVE");
    expect((await seriesRow(theirs.seriesId)).state).toBe("PAUSED"); // untouched
  });

  it("resuming early, before the pause-until date, works", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-12-15"));
    await complete(userId, a.id, "2026-11-16");
    const resumed = okValue(await resumeSeries(ctx("2026-11-18"), seriesId, 2));
    expect(resumed.series).toMatchObject({ state: "ACTIVE", pausedUntil: null });
    expect(resumed.created?.occurrenceKey).toBe("2026-11-23");
  });

  it("resuming after the pause expired (never reconciled) skips every missed date", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-11-20"));
    await complete(userId, a.id, "2026-11-16");
    const resumed = okValue(await resumeSeries(ctx("2026-12-03"), seriesId, 2)); // 23 Nov, 30 Nov were missed
    expect(resumed.created?.occurrenceKey).toBe("2026-12-07");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-12-07"]);
  });

  it("completing the tail after its pause expired but before anyone reconciled still creates exactly one successor", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    okValue(await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-11-24"));
    const done = await complete(userId, a.id, "2026-11-25");
    expect(done).toMatchObject({ successor: { occurrenceKey: "2026-11-30" }, seriesState: "ACTIVE" });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-11-30"]);
    expect(await view(seriesId)).toMatchObject({ state: "ACTIVE", pausedUntil: null });
  });

  it("resuming an active series is a harmless no-op (a retried request)", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    okValue(await pauseSeries(ctx("2026-11-02"), seriesId, 1));
    okValue(await resumeSeries(ctx("2026-11-03"), seriesId, 2));
    const again = okValue(await resumeSeries(ctx("2026-11-03"), seriesId, 2)); // stale version, but already active
    expect(again.created).toBeNull();
    expect(again.series.state).toBe("ACTIVE");
  });

  it("refuses bad pause requests", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    for (const until of ["2026-11-02", "2026-11-01", "2026-02-30", "soon"]) {
      expect(await pauseSeries(ctx("2026-11-02"), seriesId, 1, until)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(await pauseSeries(ctx("2026-11-02"), "not an id", 1)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await view(seriesId)).version).toBe(1);
    // re-pausing with a new date is fine
    okValue(await pauseSeries(ctx("2026-11-02"), seriesId, 1, "2026-11-10"));
    expect(okValue(await pauseSeries(ctx("2026-11-02"), seriesId, 2, "2026-11-20"))).toMatchObject({ pausedUntil: "2026-11-20", version: 3 });
  });
});

describe("end date", () => {
  it("is inclusive: the end date's own occurrence is created, nothing after, and the series is then ended", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-16" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    const third = (await complete(userId, second.id, "2026-11-09")).successor!;
    expect(third.occurrenceKey).toBe("2026-11-16");
    const last = await complete(userId, third.id, "2026-11-16");
    expect(last).toMatchObject({ successor: null, seriesState: "ENDED" });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect((await view(seriesId)).state).toBe("ENDED");
  });

  it("an unfinished instance of an ended series stays actionable and creates nothing beyond the end date", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-09" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!; // 9 Nov = end date
    await complete(userId, second.id, "2026-11-09"); // -> ENDED
    await undo(second.id); // unfinished again, in an ended series
    await prisma.task.update({ where: { id: second.id }, data: { status: "IN_PROGRESS" } });
    expect((await view(seriesId)).state).toBe("ENDED");
    expect(await complete(userId, second.id, "2026-11-30")).toMatchObject({ alreadyCompleted: false, successor: null });
    expect((await taskRow(second.id)).status).toBe("COMPLETED");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("shortening the end date below an unfinished instance does not delete it", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    okValue(await setSeriesEndDate(ctx("2026-11-03"), seriesId, 1, "2026-11-05"));
    expect((await taskRow(second.id)).status).toBe("TODO");
    expect((await complete(userId, second.id, "2026-11-09")).successor).toBeNull();
    expect((await view(seriesId)).state).toBe("ENDED");
  });

  it("extending an ended series continues it from the nearest future occurrence; removing the end date works too", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-09" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    await complete(userId, second.id, "2026-11-09");
    const ended = await view(seriesId);
    expect(ended.state).toBe("ENDED");

    const extended = okValue(await setSeriesEndDate(ctx("2026-11-17"), seriesId, ended.version, "2026-12-31"));
    expect(extended.series).toMatchObject({ state: "ACTIVE", endDate: "2026-12-31" });
    expect(extended.created?.occurrenceKey).toBe("2026-11-23"); // nearest future occurrence, no backlog

    const open = okValue(await setSeriesEndDate(ctx("2026-11-17"), seriesId, extended.series.version, null));
    expect(open.series.endDate).toBeNull();
  });

  it("extending an ended series whose last instance is unfinished brings it back without creating anything yet", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-09" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    await complete(userId, second.id, "2026-11-09");
    await undo(second.id);
    const extended = okValue(await setSeriesEndDate(ctx("2026-11-10"), seriesId, (await view(seriesId)).version, "2026-12-31"));
    expect(extended.series.state).toBe("ACTIVE");
    expect(extended.created).toBeNull();
    expect((await complete(userId, second.id, "2026-11-11")).successor?.occurrenceKey).toBe("2026-11-16");
  });

  it("an extension that still leaves no room keeps the series ended", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-09" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    await complete(userId, second.id, "2026-11-09");
    const result = okValue(await setSeriesEndDate(ctx("2026-11-10"), seriesId, (await view(seriesId)).version, "2026-11-12"));
    expect(result.series).toMatchObject({ state: "ENDED", endDate: "2026-11-12" });
    expect(result.created).toBeNull();
  });

  it("rejects an end date before the first planned date, and stale versions", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    expect(await setSeriesEndDate(ctx("2026-11-02"), seriesId, 1, "2026-11-01")).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    okValue(await setSeriesEndDate(ctx("2026-11-02"), seriesId, 1, "2026-12-01"));
    expect(await setSeriesEndDate(ctx("2026-11-02"), seriesId, 1, "2027-01-01")).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 2 } });
    expect((await view(seriesId)).endDate).toBe("2026-12-01");
  });
});

describe("turning recurrence off", () => {
  it("detaches the current task, keeps its content and history, and stops the series for good", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", deadlineDate: "2026-11-05", rescheduleCount: 1 });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!;
    const bBefore = await taskRow(b.id);

    const result = okValue(await disableRecurrence(ctx("2026-11-03"), b.id, 1));
    expect(result.seriesId).toBe(seriesId);
    expect(await view(seriesId)).toMatchObject({ state: "STOPPED", version: 2 });

    const after = await taskRow(b.id);
    expect(after).toMatchObject({ id: b.id, seriesId: null, occurrenceKey: null, predecessorId: a.id, status: bBefore.status, title: bBefore.title, rescheduleCount: bBefore.rescheduleCount });
    expect(dates(after)).toEqual(dates(bBefore)); // dates untouched
    expect(after.status).not.toBe("COMPLETED"); // never completed automatically

    expect((await taskRow(a.id)).seriesId).toBe(seriesId); // completed history stays linked
    expect(await prisma.task.count({ where: { userId } })).toBe(2); // nothing deleted
    // the detached task is now ordinary: completing it creates nothing
    expect((await complete(userId, b.id, "2026-11-09")).successor).toBeNull();
    expect(await prisma.task.count({ where: { userId } })).toBe(2);
  });

  it("reopening and re-completing historical instances of a stopped series can never restart it", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "DAILY" });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!;
    const c = (await complete(userId, b.id, "2026-11-03")).successor!;
    okValue(await disableRecurrence(ctx("2026-11-03"), c.id, 1));
    const count = await prisma.task.count({ where: { userId } });

    for (const id of [a.id, b.id]) {
      await undo(id);
      expect(await complete(userId, id, "2026-11-20")).toMatchObject({ successor: null, seriesState: "STOPPED" });
    }
    expect(await prisma.task.count({ where: { userId } })).toBe(count);
    expect((await view(seriesId)).state).toBe("STOPPED");
  });

  it("every way out of STOPPED is refused", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    okValue(await stopSeries(ctx("2026-11-02"), seriesId, 1));
    const refused = { ok: false, error: { code: "SERIES_STOPPED" } };
    expect(await pauseSeries(ctx("2026-11-03"), seriesId, 2)).toMatchObject(refused);
    expect(await resumeSeries(ctx("2026-11-03"), seriesId, 2)).toMatchObject(refused);
    expect(await setSeriesEndDate(ctx("2026-11-03"), seriesId, 2, "2027-01-01")).toMatchObject(refused);
    expect(await updateSeries(ctx("2026-11-03"), seriesId, 2, { title: "x" })).toMatchObject(refused);
    expect(await stopSeries(ctx("2026-11-03"), seriesId, 2)).toMatchObject(refused);
    expect(await disableRecurrence(ctx("2026-11-03"), task.id, 2)).toMatchObject(refused);
    expect(await view(seriesId)).toMatchObject({ state: "STOPPED", version: 2 });
    // stopping never touches the tasks
    expect((await taskRow(task.id)).seriesId).toBe(seriesId);
  });

  it("is refused for a task that does not repeat, and for a stale version", async () => {
    const ordinary = await createTask(userId, { plannedDate: "2026-11-02" });
    expect(await disableRecurrence(ctx("2026-11-02"), ordinary.id, 1)).toMatchObject({ ok: false, error: { code: "NOT_RECURRING" } });
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    okValue(await pauseSeries(ctx("2026-11-02"), seriesId, 1));
    expect(await disableRecurrence(ctx("2026-11-02"), task.id, 1)).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 2 } });
    expect((await taskRow(task.id)).seriesId).toBe(seriesId); // nothing changed
  });

  it("a stopped series is not reconciled or revived by the pause check", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    okValue(await pauseSeries(ctx("2026-11-02"), seriesId, 1, "2026-11-10"));
    okValue(await stopSeries(ctx("2026-11-03"), seriesId, 2));
    expect(await reconcileExpiredPauses(ctx("2026-11-20"))).toMatchObject({ reconciled: 0 });
    expect((await view(seriesId)).state).toBe("STOPPED");
  });
});

describe("editing the whole series (this and future tasks)", () => {
  it("copies template changes to every UNFINISHED instance, never to completed history, and new instances use them", async () => {
    const category = await createCategory(userId, "Work");
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", title: "Old", description: "old text", importance: "LOW", estimatedMinutes: 30 });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!;
    const c = (await complete(userId, b.id, "2026-11-09")).successor!;
    await undo(b.id); // b unfinished again: unfinished = b, c

    const updated = okValue(await updateSeries(ctx("2026-11-10"), seriesId, 1, { title: "New", description: "new text", importance: "HIGH", estimatedMinutes: 90, categoryId: category.id }));
    expect(updated).toMatchObject({ title: "New", importance: "HIGH", estimatedMinutes: 90, categoryId: category.id, version: 2 });

    const rows = await instancesOf(seriesId);
    expect(rows.map((r) => [r.title, r.status])).toEqual([["Old", "COMPLETED"], ["New", "TODO"], ["New", "TODO"]]); // history kept
    expect(rows.filter((r) => r.status !== "COMPLETED").every((r) => r.description === "new text" && r.importance === "HIGH" && r.estimatedMinutes === 90 && r.categoryId === category.id)).toBe(true);
    expect(rows[0]).toMatchObject({ description: "old text", importance: "LOW", estimatedMinutes: 30, categoryId: null });

    const d = (await complete(userId, c.id, "2026-11-12")).successor!;
    expect(await taskRow(d.id)).toMatchObject({ title: "New", importance: "HIGH", categoryId: category.id });
  });

  it("can clear the description, duration and category", async () => {
    const category = await createCategory(userId);
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY", description: "x", estimatedMinutes: 30, categoryId: category.id });
    const updated = okValue(await updateSeries(ctx("2026-11-02"), seriesId, 1, { description: "  ", estimatedMinutes: null, categoryId: null }));
    expect(updated).toMatchObject({ description: null, estimatedMinutes: null, categoryId: null });
    expect((await prisma.task.findFirstOrThrow({ where: { seriesId } }))).toMatchObject({ description: null, estimatedMinutes: null, categoryId: null });
  });

  it("a schedule change recalculates only the edited instance; other unfinished instances keep their dates", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!; // 9 Nov
    await undo(a.id); // unfinished: a (2 Nov) and b (9 Nov)

    const updated = okValue(await updateSeries(ctx("2026-11-03"), seriesId, 1, { type: "WEEKLY", weekdays: [3] }, { fromInstanceId: b.id })); // Mondays -> Wednesdays
    expect(updated).toMatchObject({ type: "WEEKLY", weekdays: [3], anchorDate: "2026-11-11", version: 2 });
    expect(await taskRow(b.id)).toMatchObject({ occurrenceKey: "2026-11-11" });
    expect(dateFromDb((await taskRow(b.id)).plannedDate)).toBe("2026-11-11");
    expect(await taskRow(a.id)).toMatchObject({ occurrenceKey: "2026-11-02" }); // untouched
    expect((await complete(userId, b.id, "2026-11-11")).successor?.occurrenceKey).toBe("2026-11-18"); // new instances follow the new rule
  });

  it("after a schedule edit makes a different instance the latest one, completing an EARLIER instance creates nothing", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!; // 9 Nov
    await undo(a.id); // a (2 Nov) and b (9 Nov) are unfinished
    // Monthly on the 20th: a moves to 20 Nov, so a is now the LATEST instance and b an earlier one.
    okValue(await updateSeries(ctx("2026-11-03"), seriesId, 1, { type: "MONTHLY", monthlyDay: 20 }, { fromInstanceId: a.id }));
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09", "2026-11-20"]);

    // b is not the tail, so completing it (even long after) does not push the series forward …
    expect(await complete(userId, b.id, "2026-12-01")).toMatchObject({ successor: null });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09", "2026-11-20"]);
    // … the tail (a) does, exactly once.
    expect((await complete(userId, a.id, "2026-12-01")).successor?.occurrenceKey).toBe("2026-12-20");
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09", "2026-11-20", "2026-12-20"]);
    // a already had a successor link (to b), so the new instance is created unlinked rather than not at all
    expect((await instancesOf(seriesId))[2].predecessorId).toBeNull();
  });

  it("an instance whose date was postponed by hand keeps that date through a schedule change", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", deadlineDate: "2026-11-05" });
    await prisma.task.update({ where: { id: task.id }, data: { plannedDate: new Date("2026-11-04T00:00:00Z"), deadlineDate: new Date("2026-11-08T00:00:00Z"), rescheduleCount: 1 } });
    const before = await taskRow(task.id);
    okValue(await updateSeries(ctx("2026-11-03"), seriesId, 1, { type: "WEEKLY", weekdays: [5], deadlineOffsetDays: 9 }, { fromInstanceId: task.id }));
    const after = await taskRow(task.id);
    expect([after.occurrenceKey, after.plannedDate, after.deadlineDate, after.rescheduleCount]).toEqual([before.occurrenceKey, before.plannedDate, before.deadlineDate, before.rescheduleCount]);
    expect(await view(seriesId)).toMatchObject({ weekdays: [5], deadlineOffsetDays: 9 });
  });

  it("a deadline-rule change moves the edited instance's deadline through the normal reschedule rules", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedTime: "09:00", deadlineDate: "2026-11-05", deadlineTime: "17:00" });
    okValue(await updateSeries(ctx("2026-11-02"), seriesId, 1, { deadlineOffsetDays: 5 }, { fromInstanceId: task.id }));
    const moved = await taskRow(task.id);
    expect(dates(moved)).toEqual({ planned: ["2026-11-02", "09:00"], deadline: ["2026-11-07", "17:00"], original: "2026-11-05" }); // original deadline preserved
    expect(moved.rescheduleCount).toBe(1);

    okValue(await updateSeries(ctx("2026-11-02"), seriesId, 2, { deadlineOffsetDays: null, deadlineTime: null }, { fromInstanceId: task.id }));
    const removed = await taskRow(task.id);
    expect(dates(removed).deadline).toEqual([null, null]);
    expect(removed.rescheduleCount).toBe(2);
    expect(dates(removed).original).toBe("2026-11-05");
  });

  it("the time of day of a timed series can change (09:00 → 10:00)", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "DAILY", plannedTime: "09:00" });
    const updated = okValue(await updateSeries(ctx("2026-11-02", "08:00"), seriesId, 1, { plannedTime: "10:00" }, { fromInstanceId: task.id }));
    expect(updated.plannedTime).toBe("10:00");
    expect(await taskRow(task.id)).toMatchObject({ occurrenceKey: "2026-11-02T10:00" });
    expect(dates(await taskRow(task.id)).planned).toEqual(["2026-11-02", "10:00"]);
    expect((await complete(userId, task.id, "2026-11-02", "09:00")).successor?.occurrenceKey).toBe("2026-11-03T10:00");
  });

  it("switching between date-only and timed is not supported in this stage (planned for Stage 4.3.2) and changes nothing", async () => {
    const timed = await makeRecurring(userId, { type: "DAILY", plannedTime: "09:00" });
    const toDateOnly = await updateSeries(ctx("2026-11-02"), timed.seriesId, 1, { plannedTime: null }, { fromInstanceId: timed.task.id });
    expect(toDateOnly).toMatchObject({ ok: false, error: { code: "VALIDATION", issues: [{ code: "TIME_MODE_CHANGE_NOT_SUPPORTED" }] } });
    const dateOnly = await makeRecurring(userId, { type: "DAILY" });
    const toTimed = await updateSeries(ctx("2026-11-02"), dateOnly.seriesId, 1, { plannedTime: "09:00" }, { fromInstanceId: dateOnly.task.id });
    expect(toTimed).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect([(await view(timed.seriesId)).version, (await view(timed.seriesId)).plannedTime]).toEqual([1, "09:00"]);
    expect([(await view(dateOnly.seriesId)).version, (await view(dateOnly.seriesId)).plannedTime]).toEqual([1, null]);
  });

  it("refuses a change that would give two instances the same occurrence, and rolls everything back", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    await complete(userId, a.id, "2026-11-02"); // creates 9 Nov
    await undo(a.id);
    const before = await taskRow(a.id);
    const result = await updateSeries(ctx("2026-11-03"), seriesId, 1, { type: "MONTHLY", monthlyDay: 9, title: "Renamed" }, { fromInstanceId: a.id });
    expect(result).toMatchObject({ ok: false, error: { code: "OCCURRENCE_CONFLICT" } });
    expect(await taskRow(a.id)).toEqual(before);
    expect(await view(seriesId)).toMatchObject({ type: "WEEKLY", title: expect.not.stringMatching("Renamed"), version: 1 });
  });

  it("schedule changes need the edited instance, which must be an unfinished instance of the same series", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    expect(await updateSeries(ctx("2026-11-02"), seriesId, 1, { type: "DAILY" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const other = await makeRecurring(userId, { type: "WEEKLY" });
    expect(await updateSeries(ctx("2026-11-02"), seriesId, 1, { type: "DAILY" }, { fromInstanceId: other.task.id })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await complete(userId, task.id, "2026-11-02");
    expect(await updateSeries(ctx("2026-11-03"), seriesId, 1, { type: "DAILY" }, { fromInstanceId: task.id })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect((await view(seriesId)).version).toBe(1);
  });

  it("rejects unknown fields, bad values and a stale version", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    for (const bad of [{ userId: "someone-else" }, { version: 99 }, { state: "STOPPED" }, { title: "" }, { importance: "URGENT" }, { estimatedMinutes: -5 }, { categoryId: "nope" }]) {
      expect(await updateSeries(ctx("2026-11-02"), seriesId, 1, bad as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    okValue(await updateSeries(ctx("2026-11-02"), seriesId, 1, { title: "Fresh" }));
    expect(await updateSeries(ctx("2026-11-02"), seriesId, 1, { title: "Stale" })).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 2 } });
    expect((await view(seriesId)).title).toBe("Fresh"); // the newer data was not overwritten
  });
});

describe("categories", () => {
  it("deleting a category keeps tasks AND the series; later instances have no category and the schedule continues", async () => {
    const category = await createCategory(userId, "Uni");
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", categoryId: category.id });
    expect((await view(seriesId)).categoryId).toBe(category.id);

    await prisma.category.delete({ where: { id: category.id } });
    expect((await view(seriesId)).categoryId).toBeNull();
    expect((await taskRow(task.id)).categoryId).toBeNull();

    const next = (await complete(userId, task.id, "2026-11-02")).successor!;
    expect(await taskRow(next.id)).toMatchObject({ categoryId: null, occurrenceKey: "2026-11-09", status: "TODO" });
    expect((await view(seriesId)).state).toBe("ACTIVE");
  });
});

describe("forecast", () => {
  it("projects future occurrences without creating any task or changing any counter", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", deadlineDate: "2026-11-05" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    const tasksBefore = await prisma.task.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const seriesBefore = await seriesRow(seriesId);

    const forecast = (await getSeriesForecast(ctx("2026-11-03"), seriesId, { limit: 3 }))!;
    expect(forecast.map((o) => o.key)).toEqual(["2026-11-16", "2026-11-23", "2026-11-30"]); // after the existing 9 Nov, no duplicate
    expect(forecast.map((o) => o.key)).not.toContain(second.occurrenceKey);

    expect(await prisma.task.findMany({ where: { userId }, orderBy: { id: "asc" } })).toEqual(tasksBefore);
    expect(await seriesRow(seriesId)).toEqual(seriesBefore);
  });

  it("respects the end date, pauses, ended and stopped series", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-23" });
    await complete(userId, task.id, "2026-11-02");
    expect(((await getSeriesForecast(ctx("2026-11-03"), seriesId))!).map((o) => o.key)).toEqual(["2026-11-16", "2026-11-23"]);

    okValue(await pauseSeries(ctx("2026-11-03"), seriesId, 1, null));
    expect(await getSeriesForecast(ctx("2026-11-03"), seriesId)).toEqual([]); // paused indefinitely
    okValue(await pauseSeries(ctx("2026-11-03"), seriesId, 2, "2026-11-20"));
    expect(((await getSeriesForecast(ctx("2026-11-03"), seriesId))!).map((o) => o.key)).toEqual(["2026-11-23"]); // from the pause end on
    expect(((await getSeriesForecast(ctx("2026-11-25"), seriesId))!)).toEqual([]); // expired pause, but nothing left before the end date

    okValue(await stopSeries(ctx("2026-11-03"), seriesId, 3));
    expect(await getSeriesForecast(ctx("2026-11-03"), seriesId)).toEqual([]);
  });

  it("a timed series forecasts timed occurrences", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "DAILY", plannedTime: "09:00" });
    expect(((await getSeriesForecast(ctx("2026-11-02", "08:00"), seriesId, { limit: 2 }))!).map((o) => o.key)).toEqual(["2026-11-03T09:00", "2026-11-04T09:00"]);
  });
});

describe("convertToRecurring and completeTask reject malformed ids", () => {
  it("answers 'not found' without touching the database", async () => {
    expect(await completeTask(ctx("2026-11-02"), "x'; drop table tasks;--")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await convertToRecurring(ctx("2026-11-02"), "", { type: "DAILY" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
