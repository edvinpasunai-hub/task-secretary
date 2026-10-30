// Stage 5: the Postpone action's service, against the separate test database.

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadDashboard } from "@/lib/dashboard/queries";
import { dateFromDb, timeFromDb } from "@/lib/local-time";
import { postponeTask, type PostponeResult } from "@/lib/postpone";
import { completeTask } from "@/lib/recurrence/service";
import { getReminders, listReminders } from "@/lib/reminders/service";
import { archiveTask, trashTask } from "@/lib/trash/service";

import { at, createTask, createUser, ctxFor, instancesOf, keysOf, newId, prisma, resetDatabase } from "../helpers/db";
import { makeRecurring, seriesRow } from "../helpers/recurrence";

let userId: string;
let other: string;
beforeEach(async () => {
  await resetDatabase();
  userId = await createUser("me");
  other = await createUser("other");
});
afterAll(() => prisma.$disconnect());

const TZ = "Europe/Tallinn";
const NOW = at("2026-11-10", "14:30"); // Tuesday 10 Nov
const run = (taskId: string, newDate: string, expectedDeadlineDate: string, o: { now?: Date; user?: string; timeZone?: string } = {}) =>
  postponeTask({ userId: o.user ?? userId, timeZone: o.timeZone ?? TZ, now: o.now ?? NOW }, { taskId, newDate, expectedDeadlineDate });
const code = (r: PostponeResult) => (r.ok ? "OK" : r.code);
const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });

describe("moving the deadline", () => {
  it("moves the date, sets the status to Postponed and counts one reschedule (the original deadline is kept)", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10", status: "TODO" });
    expect((await run(task.id, "2026-11-11", "2026-11-10")).ok).toBe(true);
    const after = await row(task.id);
    expect(dateFromDb(after.deadlineDate)).toBe("2026-11-11");
    expect(after.status).toBe("POSTPONED");
    expect(after.rescheduleCount).toBe(1);
    expect(dateFromDb(after.originalDeadlineDate)).toBe("2026-11-10");
    // A second postponement counts again and still keeps the very first deadline.
    await run(task.id, "2026-11-16", "2026-11-11");
    const again = await row(task.id);
    expect([dateFromDb(again.deadlineDate), again.rescheduleCount, dateFromDb(again.originalDeadlineDate)]).toEqual(["2026-11-16", 2, "2026-11-10"]);
  });

  it("keeps the time of a timed deadline, and a date-only deadline stays date-only", async () => {
    const timed = await createTask(userId, { deadlineDate: "2026-11-10", deadlineTime: "16:45" });
    const dateOnly = await createTask(userId, { deadlineDate: "2026-11-10" });
    await run(timed.id, "2026-11-13", "2026-11-10");
    await run(dateOnly.id, "2026-11-13", "2026-11-10");
    expect(timeFromDb((await row(timed.id)).deadlineTime)).toBe("16:45");
    expect((await row(dateOnly.id)).deadlineTime).toBeNull();
  });

  it("postpones an overdue task to a day after today, and from IN_PROGRESS too", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-01", status: "IN_PROGRESS" });
    expect((await run(task.id, "2026-11-11", "2026-11-01")).ok).toBe(true);
    expect((await row(task.id)).status).toBe("POSTPONED");
  });

  it("leaves everything else about the task alone", async () => {
    const task = await createTask(userId, { title: "Keep", description: "text", deadlineDate: "2026-11-10", plannedDate: "2026-11-10", priority: "HIGH", estimatedMinutes: 30 });
    const before = await row(task.id);
    await run(task.id, "2026-11-12", "2026-11-10");
    const after = await row(task.id);
    expect({ ...after, deadlineDate: 0, status: 0, rescheduleCount: 0, updatedAt: 0 }).toEqual({ ...before, deadlineDate: 0, status: 0, rescheduleCount: 0, updatedAt: 0 });
  });

  it("the dashboard follows: the task moves to the right section", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10", deadlineTime: "09:00" }); // overdue at 14:30
    const dash = (now = NOW) => loadDashboard({ userId, name: null, timeZone: TZ, now });
    expect((await dash()).counts.overdue).toBe(1);
    await run(task.id, "2026-11-12", "2026-11-10");
    const after = await dash();
    expect(after.counts).toMatchObject({ overdue: 0, today: 0, upcoming: 1 });
    expect(after.sections.upcoming[0].status).toBe("POSTPONED");
  });
});

describe("what is refused", () => {
  it("dates that are not in the future, not later than the deadline, invalid or too far away", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-13" });
    expect(code(await run(task.id, "2026-11-10", "2026-11-13"))).toBe("NOT_FUTURE"); // today
    expect(code(await run(task.id, "2026-11-09", "2026-11-13"))).toBe("NOT_FUTURE"); // the past
    expect(code(await run(task.id, "2026-11-13", "2026-11-13"))).toBe("NOT_LATER"); // the same day
    expect(code(await run(task.id, "2026-11-12", "2026-11-13"))).toBe("NOT_LATER"); // earlier than the deadline
    expect(code(await run(task.id, "tomorrow", "2026-11-13"))).toBe("INVALID_DATE");
    expect(code(await run(task.id, "2026-13-45", "2026-11-13"))).toBe("INVALID_DATE");
    expect(code(await run(task.id, "2050-01-01", "2026-11-13"))).toBe("TOO_FAR");
    const after = await row(task.id);
    expect([dateFromDb(after.deadlineDate), after.status, after.rescheduleCount]).toEqual(["2026-11-13", "TODO", 0]); // nothing changed
  });

  it("finished tasks, tasks without a deadline, and tasks in Trash or the archive", async () => {
    const done = await createTask(userId, { deadlineDate: "2026-11-10", status: "COMPLETED" });
    const noDeadline = await createTask(userId, {});
    const trashed = await createTask(userId, { deadlineDate: "2026-11-10" });
    const archived = await createTask(userId, { deadlineDate: "2026-11-10", status: "COMPLETED" });
    await trashTask(ctxFor(userId), trashed.id);
    await archiveTask(ctxFor(userId), archived.id);
    expect(code(await run(done.id, "2026-11-12", "2026-11-10"))).toBe("COMPLETED");
    expect(code(await run(noDeadline.id, "2026-11-12", "2026-11-10"))).toBe("NO_DEADLINE");
    expect(code(await run(trashed.id, "2026-11-12", "2026-11-10"))).toBe("NOT_FOUND");
    expect(code(await run(archived.id, "2026-11-12", "2026-11-10"))).toBe("NOT_FOUND");
  });

  it("another user's task, unknown and malformed ids", async () => {
    const theirs = await createTask(other, { deadlineDate: "2026-11-10" });
    expect(code(await run(theirs.id, "2026-11-12", "2026-11-10"))).toBe("NOT_FOUND");
    expect(dateFromDb((await row(theirs.id)).deadlineDate)).toBe("2026-11-10");
    for (const id of [newId("t"), "", "x", "../x"]) expect(code(await run(id, "2026-11-12", "2026-11-10"))).toBe("NOT_FOUND");
  });

  it("a stale request: the deadline is no longer the one the user saw", async () => {
    const task = await createTask(userId, { deadlineDate: "2026-11-10" });
    await prisma.task.update({ where: { id: task.id }, data: { deadlineDate: new Date("2026-11-11T00:00:00Z") } }); // changed elsewhere
    expect(code(await run(task.id, "2026-11-14", "2026-11-10"))).toBe("STALE");
    expect(dateFromDb((await row(task.id)).deadlineDate)).toBe("2026-11-11");
  });

  it("simultaneous requests: exactly one is applied, the rest are refused", async () => {
    for (let round = 0; round < 3; round++) {
      const task = await createTask(userId, { deadlineDate: "2026-11-10" });
      const dates = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"];
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => run(task.id, dates[i % dates.length], "2026-11-10")));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "STALE")).toBe(true);
      const after = await row(task.id);
      expect(after.rescheduleCount).toBe(1); // counted once
      expect(after.status).toBe("POSTPONED");
    }
  });
});

describe("the user's time zone", () => {
  it("'today' is the user's own day: the same instant can mean different postponement limits", async () => {
    // 2026-11-10 23:30 UTC: still the 10th in London, already the 11th in Tallinn.
    const now = new Date("2026-11-10T23:30:00Z");
    const task = await createTask(userId, { deadlineDate: "2026-11-09" });
    expect(code(await run(task.id, "2026-11-11", "2026-11-09", { now, timeZone: "Europe/London" }))).toBe("OK"); // tomorrow in London
    const second = await createTask(userId, { deadlineDate: "2026-11-09" });
    expect(code(await run(second.id, "2026-11-11", "2026-11-09", { now, timeZone: "Europe/Tallinn" }))).toBe("NOT_FUTURE"); // that is today in Tallinn
    expect(code(await run(second.id, "2026-11-12", "2026-11-09", { now, timeZone: "Europe/Tallinn" }))).toBe("OK");
  });
});

describe("reminders follow the new deadline", () => {
  it("the old reminder disappears and the new date gets its own, without duplicates", async () => {
    const task = await createTask(userId, { title: "Due", deadlineDate: "2026-11-11" });
    const first = await getReminders({ userId, now: at("2026-11-10", "10:00") });
    expect(first.items.map((i) => i.title)).toEqual(["Due"]);
    await run(task.id, "2026-11-14", "2026-11-11", { now: at("2026-11-10", "10:05") });
    expect((await listReminders({ userId, now: at("2026-11-10", "10:06") })).items).toHaveLength(0); // the old one is hidden at once
    await getReminders({ userId, now: at("2026-11-13", "10:00") });
    await getReminders({ userId, now: at("2026-11-13", "10:01") });
    expect((await listReminders({ userId, now: at("2026-11-13", "10:02") })).items.map((i) => i.headline)).toEqual(["Due tomorrow"]);
    expect(await prisma.reminder.count({ where: { taskId: task.id } })).toBe(2); // the old one stays, hidden, and one new
  });
});

describe("repeating tasks", () => {
  it("postpones only this occurrence: the series rule, its version and the key stay as they are", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-09", deadlineDate: "2026-11-11", title: "Weekly" });
    const seriesBefore = await seriesRow(seriesId);
    expect((await run(task.id, "2026-11-20", "2026-11-11")).ok).toBe(true);

    const after = await row(task.id);
    expect(dateFromDb(after.deadlineDate)).toBe("2026-11-20");
    expect(after.occurrenceKey).toBe("2026-11-09"); // the scheduled occurrence does not move
    expect(after.seriesId).toBe(seriesId);
    expect(await seriesRow(seriesId)).toEqual(seriesBefore); // rule, version, state, offset: untouched
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09"]); // nothing was created or removed
  });

  it("the next occurrence still follows the series rule when the postponed one is completed", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-09", deadlineDate: "2026-11-11" });
    await run(task.id, "2026-11-20", "2026-11-11");
    await completeTask(ctxFor(userId, "2026-11-10", "15:00"), task.id);
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-09", "2026-11-16"]);
    const next = (await instancesOf(seriesId))[1];
    expect(dateFromDb(next.deadlineDate)).toBe("2026-11-18"); // the series' own offset (2 days), not the postponed date
  });

  it("other occurrences of the series are not affected", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-02", deadlineDate: "2026-11-04" });
    await completeTask(ctxFor(userId, "2026-11-02"), task.id);
    const [, open] = await instancesOf(seriesId);
    const before = await prisma.task.findMany({ where: { seriesId, id: { not: open.id } } });
    await run(open.id, "2026-11-30", dateFromDb(open.deadlineDate)!);
    expect(await prisma.task.findMany({ where: { seriesId, id: { not: open.id } } })).toEqual(before);
  });
});
