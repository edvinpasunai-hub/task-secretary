// Stage 4.3.2 backend: atomic creation, switching between date-only and timed,
// and saving a task together with its series ("this and future tasks").

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { dateFromDb, timeFromDb } from "@/lib/local-time";
import {
  convertInTx,
  createRecurringTask,
  disableRecurrenceInTx,
  getSeries,
  getSeriesForecast,
  pauseSeries,
  runInTransaction,
  setSeriesEndDate,
  updateSeries,
  updateTaskAndSeries,
  updateTaskAndSeriesInTx,
} from "@/lib/recurrence/service";
import type { NewTaskFields } from "@/lib/recurrence/types";

import { assertTestDatabase, createCategory, createTask, createUser, ctxFor, instancesOf, keysOf, prisma, resetDatabase } from "../helpers/db";
import { complete, dates, makeRecurring, seriesRow, taskRow, undo } from "../helpers/recurrence";

let userId: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser();
});
afterEach(removeFailTrigger);
afterAll(() => prisma.$disconnect());

const ctx = (date = "2026-11-02", time = "12:00") => ctxFor(userId, date, time);
const view = async (id: string) => (await getSeries(ctx(), id))!;
const okValue = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.error)}`);
  return result.value as T;
};

const fields = (o: Partial<NewTaskFields> = {}): NewTaskFields => ({
  title: "Report", description: null, importance: "NORMAL", categoryId: null, estimatedMinutes: null,
  plannedDate: "2026-11-02", plannedTime: null, deadlineDate: null, deadlineTime: null, ...o,
});

// A test-only trigger: inserting a task titled FAIL_ME fails, to prove rollbacks.
async function installFailTrigger() {
  await assertTestDatabase();
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger AS $$ BEGIN IF NEW.title = 'FAIL_ME' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_insert ON tasks`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_insert BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION test_fail_insert()`);
}
async function removeFailTrigger() {
  await assertTestDatabase();
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_insert ON tasks`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_insert()`);
}
const counts = async () => ({ tasks: await prisma.task.count(), series: await prisma.recurringSeries.count() });

describe("creating a repeating task in one step", () => {
  it("creates the series and its first task together, with every field", async () => {
    const category = await createCategory(userId, "Work");
    const result = okValue(
      await createRecurringTask(
        ctx(),
        fields({ title: "Weekly report", description: "Write it", importance: "HIGH", estimatedMinutes: 60, categoryId: category.id, plannedTime: "09:00", deadlineDate: "2026-11-05", deadlineTime: "17:00" }),
        { type: "WEEKLY", endDate: "2027-01-31" },
      ),
    );
    expect(await counts()).toEqual({ tasks: 1, series: 1 });
    const task = await taskRow(result.taskId);
    expect(task).toMatchObject({ userId, seriesId: result.seriesId, occurrenceKey: "2026-11-02T09:00", title: "Weekly report", status: "TODO", importance: "HIGH", estimatedMinutes: 60, categoryId: category.id, rescheduleCount: 0, predecessorId: null });
    expect(dates(task)).toEqual({ planned: ["2026-11-02", "09:00"], deadline: ["2026-11-05", "17:00"], original: "2026-11-05" });
    expect(await view(result.seriesId)).toMatchObject({ type: "WEEKLY", weekdays: [1], anchorDate: "2026-11-02", plannedTime: "09:00", deadlineOffsetDays: 3, deadlineTime: "17:00", endDate: "2027-01-31", state: "ACTIVE", version: 1, title: "Weekly report", categoryId: category.id });
  });

  it("works for every repeat type, date-only and timed", async () => {
    for (const [type, extra, date] of [["DAILY", {}, "2026-11-02"], ["WEEKLY", {}, "2026-11-04"], ["MONTHLY", {}, "2026-01-31"], ["CUSTOM_WEEKDAYS", { weekdays: [1, 3, 5] }, "2026-11-02"]] as Array<["DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM_WEEKDAYS", { weekdays?: number[] }, string]>) {
      for (const plannedTime of [null, "08:30"]) {
        const created = okValue(await createRecurringTask(ctx(), fields({ plannedDate: date, plannedTime }), { type, ...extra }));
        expect((await view(created.seriesId)).plannedTime).toBe(plannedTime);
      }
    }
    expect(await counts()).toEqual({ tasks: 8, series: 8 });
  });

  it("then behaves like any series: completing it creates the next one", async () => {
    const created = okValue(await createRecurringTask(ctx(), fields({ deadlineDate: "2026-11-03" }), { type: "WEEKLY" }));
    const next = (await complete(userId, created.taskId, "2026-11-02")).successor!;
    expect(next.occurrenceKey).toBe("2026-11-09");
    expect(dates(await taskRow(next.id)).deadline).toEqual(["2026-11-10", null]);
  });

  it("without a planned date nothing is created", async () => {
    const result = await createRecurringTask(ctx(), fields({ plannedDate: null }), { type: "DAILY" });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION", issues: [{ code: "PLANNED_DATE_REQUIRED" }] } });
    expect(await counts()).toEqual({ tasks: 0, series: 0 });
  });

  it("an invalid rule creates nothing, whichever part is wrong", async () => {
    for (const [task, repeat] of [
      [fields(), { type: "CUSTOM_WEEKDAYS", weekdays: [] }],
      [fields({ plannedDate: "2026-11-03" }), { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5] }], // a Tuesday
      [fields(), { type: "DAILY", endDate: "2026-11-01" }],
      [fields(), { type: "YEARLY" }],
      [fields(), { type: "DAILY", userId: "evil" }],
      [fields({ deadlineDate: "2040-01-01" }), { type: "DAILY" }], // deadline more than 3650 days away
    ] as Array<[NewTaskFields, never]>) {
      expect(await createRecurringTask(ctx(), task, repeat)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(await counts()).toEqual({ tasks: 0, series: 0 });
  });

  it("someone else's category is refused and nothing is created", async () => {
    const other = await createUser("other");
    const theirs = await createCategory(other, "Private");
    expect(await createRecurringTask(ctx(), fields({ categoryId: theirs.id }), { type: "DAILY" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await counts()).toEqual({ tasks: 0, series: 0 });
  });

  it("if saving the task fails after the series was inserted, the series is rolled back too (no partial state)", async () => {
    await installFailTrigger();
    await expect(createRecurringTask(ctx(), fields({ title: "FAIL_ME" }), { type: "WEEKLY" })).rejects.toThrow();
    expect(await counts()).toEqual({ tasks: 0, series: 0 });
    await removeFailTrigger();
    okValue(await createRecurringTask(ctx(), fields({ title: "FAIL_ME" }), { type: "WEEKLY" })); // the same request works once the problem is gone
    expect(await counts()).toEqual({ tasks: 1, series: 1 });
  });

  it("the series always belongs to the logged-in user", async () => {
    const created = okValue(await createRecurringTask(ctx(), fields(), { type: "DAILY" }));
    expect((await seriesRow(created.seriesId)).userId).toBe(userId);
    expect((await taskRow(created.taskId)).userId).toBe(userId);
  });
});

describe("converting an existing task together with other edits", () => {
  it("task edits and the new series are saved in one transaction", async () => {
    const task = await createTask(userId, { title: "Old", plannedDate: "2026-11-02" });
    const outcome = await runInTransaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { title: "New title" } });
      return convertInTx(tx, ctx(), task.id, { type: "WEEKLY" });
    });
    expect(outcome.ok).toBe(true);
    expect(await view(okValue(outcome).seriesId)).toMatchObject({ title: "New title" }); // the series is built from the EDITED task
    expect(await taskRow(task.id)).toMatchObject({ title: "New title" });
  });

  it("if converting fails, the task edits are rolled back too", async () => {
    const task = await createTask(userId, { title: "Old", plannedDate: "2026-11-03" });
    const outcome = await runInTransaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { title: "Edited" } });
      return convertInTx(tx, ctx(), task.id, { type: "CUSTOM_WEEKDAYS", weekdays: [1] }); // Tuesday is not Monday
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await taskRow(task.id)).toMatchObject({ title: "Old", seriesId: null });
    expect(await prisma.recurringSeries.count()).toBe(0);
  });

  it("turning repeat off together with other edits is one transaction", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const failed = await runInTransaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { title: "Edited" } });
      return disableRecurrenceInTx(tx, ctx(), task.id, 99); // stale version
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 1 } });
    expect(await taskRow(task.id)).toMatchObject({ title: "Task", seriesId });
    expect((await view(seriesId)).state).toBe("ACTIVE");

    const done = await runInTransaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { title: "Edited" } });
      return disableRecurrenceInTx(tx, ctx(), task.id, 1);
    });
    expect(done.ok).toBe(true);
    expect(await taskRow(task.id)).toMatchObject({ title: "Edited", seriesId: null, status: "TODO" });
    expect((await view(seriesId)).state).toBe("STOPPED");
  });
});

describe("switching between date-only and timed", () => {
  it("date-only → timed: the edited task gets the time, the series is timed, new instances are timed", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", deadlineDate: "2026-11-04" });
    const updated = okValue(await updateSeries(ctx(), seriesId, 1, { plannedTime: "09:30" }, { fromInstanceId: task.id }));
    expect(updated).toMatchObject({ plannedTime: "09:30", version: 2 });
    const first = await taskRow(task.id);
    expect(first).toMatchObject({ occurrenceKey: "2026-11-02T09:30" });
    expect(dates(first).planned).toEqual(["2026-11-02", "09:30"]);

    const next = (await complete(userId, task.id, "2026-11-02", "08:00")).successor!;
    expect(next.occurrenceKey).toBe("2026-11-09T09:30");
    expect(dates(await taskRow(next.id))).toMatchObject({ planned: ["2026-11-09", "09:30"], deadline: ["2026-11-11", null] });
  });

  it("timed → date-only: the time is removed from the edited task, the series and new instances", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedTime: "09:30" });
    const updated = okValue(await updateSeries(ctx(), seriesId, 1, { plannedTime: null }, { fromInstanceId: task.id }));
    expect(updated.plannedTime).toBeNull();
    expect(await taskRow(task.id)).toMatchObject({ occurrenceKey: "2026-11-02" });
    expect(dates(await taskRow(task.id)).planned).toEqual(["2026-11-02", null]);

    const next = (await complete(userId, task.id, "2026-11-02")).successor!;
    expect(next.occurrenceKey).toBe("2026-11-09");
    expect(dates(await taskRow(next.id)).planned).toEqual(["2026-11-09", null]);
  });

  it("round trip date-only → timed → date-only works, and the series never loses or duplicates an occurrence", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "DAILY" });
    const b = (await complete(userId, task.id, "2026-11-02")).successor!; // 3 Nov, date-only
    okValue(await updateSeries(ctx("2026-11-03"), seriesId, 1, { plannedTime: "18:00" }, { fromInstanceId: b.id }));
    expect(await view(seriesId)).toMatchObject({ plannedTime: "18:00", version: 2 });
    const c = (await complete(userId, b.id, "2026-11-03", "08:00")).successor!; // timed
    expect(c.occurrenceKey).toBe("2026-11-04T18:00");
    okValue(await updateSeries(ctx("2026-11-04"), seriesId, 2, { plannedTime: null }, { fromInstanceId: c.id }));
    const d = (await complete(userId, c.id, "2026-11-04", "10:00")).successor!;
    expect(d.occurrenceKey).toBe("2026-11-05");
    // the edited instances took the kind that was current when they were edited; nothing was lost or doubled
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-03T18:00", "2026-11-04", "2026-11-05"]);
  });

  it("an old date-only instance that is still the latest one continues a timed series correctly (mixed keys)", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!; // 9 Nov, date-only, unfinished
    // change the time using the EARLIER instance, so b (date-only key) stays the latest instance
    await undo(a.id);
    okValue(await updateSeries(ctx("2026-11-03"), seriesId, 1, { plannedTime: "09:00" }, { fromInstanceId: a.id }));
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02T09:00", "2026-11-09"]);
    expect((await complete(userId, a.id, "2026-11-10")).successor).toBeNull(); // a is not the tail
    expect((await complete(userId, b.id, "2026-11-05", "07:00")).successor?.occurrenceKey).toBe("2026-11-16T09:00"); // b (tail) continues, timed
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02T09:00", "2026-11-09", "2026-11-16T09:00"]);
  });

  it("a timed old tail continues a date-only series (the other direction)", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedTime: "09:00" });
    const b = (await complete(userId, a.id, "2026-11-02", "10:00")).successor!; // 9 Nov 09:00
    await undo(a.id);
    okValue(await updateSeries(ctx("2026-11-03"), seriesId, 1, { plannedTime: null }, { fromInstanceId: a.id }));
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09T09:00"]);
    expect((await complete(userId, b.id, "2026-11-05")).successor?.occurrenceKey).toBe("2026-11-16");
  });

  it("works on a daylight-saving day, in both directions", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-03-29" }); // Sunday, clocks change
    okValue(await updateSeries(ctx("2026-03-28"), seriesId, 1, { plannedTime: "03:30" }, { fromInstanceId: task.id })); // a time that does not exist that day
    expect(await taskRow(task.id)).toMatchObject({ occurrenceKey: "2026-03-29T03:30" });
    expect(dates(await taskRow(task.id)).planned).toEqual(["2026-03-29", "03:30"]);
    expect((await complete(userId, task.id, "2026-03-29", "05:00")).successor?.occurrenceKey).toBe("2026-04-05T03:30");
    okValue(await updateSeries(ctx("2026-03-30"), seriesId, 2, { plannedTime: null }, { fromInstanceId: (await instancesOf(seriesId))[1].id }));
    expect((await instancesOf(seriesId))[1].occurrenceKey).toBe("2026-04-05");
  });

  it("the forecast follows the new kind straight away", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "DAILY" });
    okValue(await updateSeries(ctx(), seriesId, 1, { plannedTime: "20:00" }, { fromInstanceId: task.id }));
    expect(((await getSeriesForecast(ctx("2026-11-02", "10:00"), seriesId, { limit: 2 }))!).map((o) => o.key)).toEqual(["2026-11-03T20:00", "2026-11-04T20:00"]);
    okValue(await updateSeries(ctx(), seriesId, 2, { plannedTime: null }, { fromInstanceId: task.id }));
    expect(((await getSeriesForecast(ctx("2026-11-02", "10:00"), seriesId, { limit: 2 }))!).map((o) => o.key)).toEqual(["2026-11-03", "2026-11-04"]);
  });

  it("a hand-postponed task keeps its date when the series changes kind", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    await prisma.task.update({ where: { id: task.id }, data: { plannedDate: new Date("2026-11-04T00:00:00Z") } });
    okValue(await updateSeries(ctx(), seriesId, 1, { plannedTime: "09:00" }, { fromInstanceId: task.id }));
    const row = await taskRow(task.id);
    expect([row.occurrenceKey, dateFromDb(row.plannedDate), timeFromDb(row.plannedTime)]).toEqual(["2026-11-02", "2026-11-04", null]);
    expect((await view(seriesId)).plannedTime).toBe("09:00");
  });

  it("an invalid time is refused and changes nothing", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    for (const bad of ["25:00", "9:00", "09:00:00", "noon"]) {
      expect(await updateSeries(ctx(), seriesId, 1, { plannedTime: bad }, { fromInstanceId: task.id })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect((await view(seriesId)).version).toBe(1);
  });
});

describe("end date inside the series update", () => {
  it("is set together with other changes in one version-checked step", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const updated = okValue(await updateSeries(ctx(), seriesId, 1, { title: "Renamed", endDate: "2026-12-14", plannedTime: "08:00" }, { fromInstanceId: task.id }));
    expect(updated).toMatchObject({ title: "Renamed", endDate: "2026-12-14", plannedTime: "08:00", version: 2 });
    expect(okValue(await updateSeries(ctx(), seriesId, 2, { endDate: null })).endDate).toBeNull();
  });

  it("an end date before the first planned date is refused", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    expect(await updateSeries(ctx(), seriesId, 1, { endDate: "2026-11-01" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await updateSeries(ctx(), seriesId, 1, { endDate: "2026-02-30" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("extending an ended series through the update brings it back and creates the next instance", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", endDate: "2026-11-09" });
    const second = (await complete(userId, task.id, "2026-11-02")).successor!;
    await complete(userId, second.id, "2026-11-09");
    expect((await view(seriesId)).state).toBe("ENDED");
    const updated = okValue(await updateSeries(ctx("2026-11-17"), seriesId, (await view(seriesId)).version, { endDate: "2026-12-31" }));
    expect(updated).toMatchObject({ state: "ACTIVE", endDate: "2026-12-31" });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-23"]);
  });

  it("agrees with setSeriesEndDate", async () => {
    const a = await makeRecurring(userId, { type: "WEEKLY" });
    const b = await makeRecurring(userId, { type: "WEEKLY" });
    const viaUpdate = okValue(await updateSeries(ctx(), a.seriesId, 1, { endDate: "2026-12-01" }));
    const viaSetter = okValue(await setSeriesEndDate(ctx(), b.seriesId, 1, "2026-12-01")).series;
    expect([viaUpdate.endDate, viaUpdate.state, viaUpdate.version]).toEqual([viaSetter.endDate, viaSetter.state, viaSetter.version]);
  });
});

describe("saving one task together with its series (this and future tasks)", () => {
  it("series changes and this task's own dates are saved together, and the version moves once", async () => {
    const { task } = await makeRecurring(userId, { type: "WEEKLY", plannedTime: "09:00", deadlineDate: "2026-11-05" });
    const result = await updateTaskAndSeries(ctx(), task.id, 1, { title: "Renamed", plannedTime: "10:00", endDate: "2026-12-31" }, { plannedDate: "2026-11-04", plannedTime: "10:00", deadlineDate: "2026-11-06", deadlineTime: null });
    expect(okValue(result)).toMatchObject({ title: "Renamed", plannedTime: "10:00", endDate: "2026-12-31", version: 2 });
    const row = await taskRow(task.id);
    expect(row.title).toBe("Renamed");
    expect(dates(row)).toEqual({ planned: ["2026-11-04", "10:00"], deadline: ["2026-11-06", null], original: "2026-11-05" }); // moving this task's date is a postponement
    expect(row.rescheduleCount).toBe(1);
    expect(row.occurrenceKey).toBe("2026-11-02T10:00"); // its scheduled occurrence is unchanged by the postponement
    const next = (await complete(userId, task.id, "2026-11-04", "12:00")).successor!;
    expect(next.occurrenceKey).toBe("2026-11-09T10:00"); // the series continues on its own schedule
  });

  it("only changed template fields should be sent: other unfinished instances keep their own edits", async () => {
    const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY", title: "Base" });
    const b = (await complete(userId, a.id, "2026-11-02")).successor!;
    await undo(a.id);
    await prisma.task.update({ where: { id: b.id }, data: { title: "Only b" } }); // an earlier "only this task" edit
    okValue(await updateTaskAndSeries(ctx(), a.id, 1, { description: "New text" }, null)); // title not in the patch
    expect(await taskRow(b.id)).toMatchObject({ title: "Only b", description: "New text" });
    okValue(await updateTaskAndSeries(ctx(), a.id, 2, { title: "Everyone" }, null)); // title IS in the patch
    expect((await instancesOf(seriesId)).map((t) => t.title)).toEqual(["Everyone", "Everyone"]);
  });

  it("with no series-level change, only the version is checked and this task's dates are saved", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const result = okValue(await updateTaskAndSeries(ctx(), task.id, 1, {}, { plannedDate: "2026-11-03", plannedTime: null, deadlineDate: null, deadlineTime: null }));
    expect(result.version).toBe(1); // no needless version bump
    expect(dateFromDb((await taskRow(task.id)).plannedDate)).toBe("2026-11-03");
    expect(await updateTaskAndSeries(ctx(), task.id, 7, {}, null)).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 1 } });
    expect((await view(seriesId)).version).toBe(1);
  });

  it("a stale form is refused as a whole: neither the series nor this task changes", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", deadlineDate: "2026-11-05" });
    okValue(await pauseSeries(ctx(), seriesId, 1)); // another tab changed the series (version 2)
    const before = { task: await taskRow(task.id), series: await seriesRow(seriesId) };
    const result = await updateTaskAndSeries(ctx(), task.id, 1, { title: "Stale edit" }, { plannedDate: "2026-11-09", plannedTime: null, deadlineDate: "2026-11-12", deadlineTime: null });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 2 } });
    expect(await taskRow(task.id)).toEqual(before.task);
    expect(await seriesRow(seriesId)).toEqual(before.series);
  });

  it("a failure half-way rolls back both the series change and this task's dates", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const before = { task: await taskRow(task.id), series: await seriesRow(seriesId) };
    // schedule change + an instance date change, then a failing step inside the same transaction
    await installFailTrigger();
    const failed = await runInTransaction(async (tx) => {
      await updateTaskAndSeriesInTx(tx, ctx(), task.id, 1, { title: "Renamed", plannedTime: "09:00" }, { plannedDate: "2026-11-03", plannedTime: "09:00", deadlineDate: null, deadlineTime: null });
      await tx.task.create({ data: { userId, title: "FAIL_ME" } });
    }).catch((error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(await taskRow(task.id)).toEqual(before.task);
    expect(await seriesRow(seriesId)).toEqual(before.series);
  });

  it("the edited task must belong to the user and to a series; a stopped series refuses", async () => {
    const other = await createUser("other");
    const theirs = await makeRecurring(other, { type: "WEEKLY" });
    expect(await updateTaskAndSeries(ctx(), theirs.task.id, 1, { title: "x" }, null)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const ordinary = await createTask(userId, { plannedDate: "2026-11-02" });
    expect(await updateTaskAndSeries(ctx(), ordinary.id, 1, { title: "x" }, null)).toMatchObject({ ok: false, error: { code: "NOT_RECURRING" } });
    const mine = await makeRecurring(userId, { type: "WEEKLY" });
    await prisma.recurringSeries.update({ where: { id: mine.seriesId }, data: { state: "STOPPED" } });
    expect(await updateTaskAndSeries(ctx(), mine.task.id, 1, { title: "x" }, null)).toMatchObject({ ok: false, error: { code: "SERIES_STOPPED" } });
    expect((await seriesRow(theirs.seriesId)).title).toBe("Task");
  });

  it("refuses unknown fields and another user's category", async () => {
    const other = await createUser("other");
    const theirs = await createCategory(other, "Private");
    const { task } = await makeRecurring(userId, { type: "WEEKLY" });
    expect(await updateTaskAndSeries(ctx(), task.id, 1, { userId: other } as never, null)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await updateTaskAndSeries(ctx(), task.id, 1, { categoryId: theirs.id }, null)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
});
