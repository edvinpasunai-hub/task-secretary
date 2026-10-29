// One user must never read or change another user's tasks, series or categories.

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  completeTask,
  convertToRecurring,
  disableRecurrence,
  getSeries,
  getSeriesForecast,
  pauseSeries,
  reconcileExpiredPauses,
  resumeSeries,
  setSeriesEndDate,
  stopSeries,
  updateSeries,
} from "@/lib/recurrence/service";

import { createCategory, createTask, createUser, ctxFor, newId, prisma, resetDatabase } from "../helpers/db";
import { complete, makeRecurring, seriesRow, taskRow, undo } from "../helpers/recurrence";

let alice: string; // owner of the data
let mallory: string; // the attacker
beforeEach(async () => {
  await resetDatabase();
  alice = await createUser("alice");
  mallory = await createUser("mallory");
});
afterAll(() => prisma.$disconnect());

const attacker = (date = "2026-11-03") => ctxFor(mallory, date);
const NOT_FOUND = { ok: false, error: { code: "NOT_FOUND" } };

async function everythingOf(userId: string) {
  return {
    tasks: await prisma.task.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    series: await prisma.recurringSeries.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    categories: await prisma.category.findMany({ where: { userId }, orderBy: { id: "asc" } }),
  };
}

describe("another user's tasks and series", () => {
  it("every operation answers 'not found' and changes nothing", async () => {
    const { task, seriesId } = await makeRecurring(alice, { type: "WEEKLY", deadlineDate: "2026-11-05" });
    const ordinary = await createTask(alice, { plannedDate: "2026-11-02" });
    const next = (await complete(alice, task.id, "2026-11-02")).successor!;
    await undo(task.id);
    const before = await everythingOf(alice);
    const version = (await seriesRow(seriesId)).version;

    expect(await completeTask(attacker(), task.id)).toMatchObject(NOT_FOUND);
    expect(await completeTask(attacker(), next.id)).toMatchObject(NOT_FOUND);
    expect(await completeTask(attacker(), ordinary.id)).toMatchObject(NOT_FOUND);
    expect(await convertToRecurring(attacker(), ordinary.id, { type: "DAILY" })).toMatchObject(NOT_FOUND);
    expect(await disableRecurrence(attacker(), task.id, version)).toMatchObject(NOT_FOUND);
    expect(await pauseSeries(attacker(), seriesId, version, null)).toMatchObject(NOT_FOUND);
    expect(await resumeSeries(attacker(), seriesId, version)).toMatchObject(NOT_FOUND);
    expect(await setSeriesEndDate(attacker(), seriesId, version, "2027-01-01")).toMatchObject(NOT_FOUND);
    expect(await stopSeries(attacker(), seriesId, version)).toMatchObject(NOT_FOUND);
    expect(await updateSeries(attacker(), seriesId, version, { title: "Hijacked" })).toMatchObject(NOT_FOUND);
    expect(await updateSeries(attacker(), seriesId, version, { type: "DAILY" }, { fromInstanceId: task.id })).toMatchObject(NOT_FOUND);
    expect(await getSeries(attacker(), seriesId)).toBeNull();
    expect(await getSeriesForecast(attacker(), seriesId)).toBeNull();
    expect(await reconcileExpiredPauses(attacker("2027-01-01"))).toMatchObject({ reconciled: 0, failed: [] });

    expect(await everythingOf(alice)).toEqual(before); // not one row of Alice's changed
  });

  it("a stranger's answer is identical to the answer for an id that does not exist (no information leak)", async () => {
    const { task, seriesId } = await makeRecurring(alice, { type: "WEEKLY" });
    const ghostTask = newId("t");
    const ghostSeries = newId("s");
    const strip = (r: { ok: boolean; error?: { code: string; message: string } }) => JSON.stringify(r.error);
    expect(strip(await completeTask(attacker(), task.id) as never)).toBe(strip(await completeTask(attacker(), ghostTask) as never));
    expect(strip(await pauseSeries(attacker(), seriesId, 1) as never)).toBe(strip(await pauseSeries(attacker(), ghostSeries, 1) as never));
    expect(strip(await updateSeries(attacker(), seriesId, 1, { title: "x" }) as never)).toBe(strip(await updateSeries(attacker(), ghostSeries, 1, { title: "x" }) as never));
    expect(strip(await disableRecurrence(attacker(), task.id, 1) as never)).toBe(strip(await disableRecurrence(attacker(), ghostTask, 1) as never));
  });

  it("an attacker's own series cannot be pointed at Alice's task", async () => {
    const { task: aliceTask } = await makeRecurring(alice, { type: "WEEKLY" });
    const mine = await makeRecurring(mallory, { type: "WEEKLY" });
    expect(await updateSeries(attacker(), mine.seriesId, 1, { type: "DAILY" }, { fromInstanceId: aliceTask.id })).toMatchObject(NOT_FOUND);
    expect((await taskRow(aliceTask.id)).occurrenceKey).toBe("2026-11-02");
    expect((await seriesRow(mine.seriesId)).version).toBe(1);
  });

  it("malformed and hostile ids are refused as 'not found'", async () => {
    for (const bad of ["", "x", "../../etc/passwd", "'; DROP TABLE tasks; --", "A".repeat(30), "a".repeat(100)]) {
      expect(await completeTask(attacker(), bad)).toMatchObject(NOT_FOUND);
      expect(await pauseSeries(attacker(), bad, 1)).toMatchObject(NOT_FOUND);
      expect(await getSeries(attacker(), bad)).toBeNull();
    }
    expect(await prisma.task.count()).toBe(0);
  });
});

describe("categories", () => {
  it("a series cannot be given another user's category", async () => {
    const theirs = await createCategory(alice, "Private");
    const { seriesId } = await makeRecurring(mallory, { type: "WEEKLY" });
    const result = await updateSeries(attacker(), seriesId, 1, { categoryId: theirs.id });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect((await seriesRow(seriesId)).categoryId).toBeNull();
    // an unknown category looks exactly the same
    const ghost = await updateSeries(attacker(), seriesId, 1, { categoryId: newId("c") });
    expect(ghost).toEqual(result);
  });

  it("a series can use the user's own category", async () => {
    const mine = await createCategory(mallory, "Mine");
    const { seriesId } = await makeRecurring(mallory, { type: "WEEKLY" });
    const result = await updateSeries(attacker(), seriesId, 1, { categoryId: mine.id });
    expect(result).toMatchObject({ ok: true, value: { categoryId: mine.id } });
  });

  it("converting a task that points at someone else's category is refused, and creates no series", async () => {
    const theirs = await createCategory(alice, "Private");
    const task = await createTask(mallory, { plannedDate: "2026-11-02", categoryId: theirs.id }); // possible only by bypassing the app
    expect(await convertToRecurring(attacker(), task.id, { type: "DAILY" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await prisma.recurringSeries.count()).toBe(0);
    expect((await taskRow(task.id)).seriesId).toBeNull();
  });
});

describe("the user id always comes from the server context", () => {
  it("fields such as userId, state or version in a request body are rejected, not obeyed", async () => {
    const { seriesId } = await makeRecurring(mallory, { type: "WEEKLY" });
    for (const body of [{ userId: alice }, { ownerId: alice }, { state: "STOPPED" }, { version: 50 }, { id: newId("s") }, { seriesId: newId("s") }]) {
      expect(await updateSeries(attacker(), seriesId, 1, body as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    const task = await createTask(mallory, { plannedDate: "2026-11-02" });
    expect(await convertToRecurring(attacker(), task.id, { type: "DAILY", userId: alice } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect((await seriesRow(seriesId)).userId).toBe(mallory);
  });

  it("series created by a user always belong to that user, and so do their instances", async () => {
    const { task, seriesId } = await makeRecurring(mallory, { type: "DAILY" });
    const next = (await complete(mallory, task.id, "2026-11-02")).successor!;
    expect((await seriesRow(seriesId)).userId).toBe(mallory);
    expect((await taskRow(next.id)).userId).toBe(mallory);
    expect(await prisma.recurringSeries.count({ where: { userId: alice } })).toBe(0);
  });
});
