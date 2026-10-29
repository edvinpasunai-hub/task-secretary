// Real parallel requests against real PostgreSQL. Mocked unit tests cannot prove
// any of this; these runs can.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeTask, disableRecurrence, getSeries, pauseSeries, reconcileExpiredPauses, resetReconcileBackoff, resumeSeries, RECONCILE_BACKOFF_MS, setSeriesEndDate, stopSeries, updateSeries } from "@/lib/recurrence/service";

import { assertTestDatabase, createUser, ctxFor, instancesOf, keysOf, prisma, resetDatabase } from "../helpers/db";
import { complete, makeRecurring, seriesRow, taskRow, undo } from "../helpers/recurrence";

let userId: string;
beforeEach(async () => {
  await resetDatabase();
  resetReconcileBackoff();
  userId = await createUser();
});
afterEach(async () => {
  await removeFailTrigger();
  vi.restoreAllMocks();
});
afterAll(() => prisma.$disconnect());

const ctx = (date: string, time = "12:00") => ctxFor(userId, date, time);

// A test-only trigger that makes inserting a task titled FAIL_ME fail, to prove
// that a failure in the middle of an operation rolls EVERYTHING back.
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

const ROUNDS = 5;

describe("simultaneous completion requests", () => {
  it("12 parallel completions of the same instance create exactly one successor (repeated for several rounds)", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
      const results = await Promise.all(Array.from({ length: 12 }, () => completeTask(ctx("2026-11-03"), task.id)));

      expect(results.every((r) => r.ok)).toBe(true);
      const outcomes = results.map((r) => (r.ok ? r.value : null)!);
      expect(outcomes.filter((o) => !o.alreadyCompleted)).toHaveLength(1); // exactly one request did the work
      const successorIds = new Set(outcomes.map((o) => o.successor?.id));
      expect(successorIds.size).toBe(1);
      expect(successorIds.has(undefined)).toBe(false); // everyone is told about the same successor

      const rows = await instancesOf(seriesId);
      expect(keysOf(rows)).toEqual(["2026-11-02", "2026-11-09"]);
      expect(rows.filter((r) => r.status === "COMPLETED")).toHaveLength(1);
      expect(rows[1].predecessorId).toBe(task.id);
    }
  });

  it("an older reverted instance and the tail completed at the same time: only the tail creates the next one", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { task: a, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
      const b = (await complete(userId, a.id, "2026-11-02")).successor!;
      await undo(a.id);
      const results = await Promise.all([completeTask(ctx("2026-11-10"), a.id), completeTask(ctx("2026-11-10"), b.id)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
      expect((await instancesOf(seriesId))[2].predecessorId).toBe(b.id);
    }
  });

  it("completions racing with a pause leave a consistent state: never a half-done completion or a second successor", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
      const [done, paused] = await Promise.all([completeTask(ctx("2026-11-03"), task.id), pauseSeries(ctx("2026-11-03"), seriesId, 1)]);
      expect(done.ok && paused.ok).toBe(true);
      const rows = await instancesOf(seriesId);
      expect(rows[0].status).toBe("COMPLETED");
      expect(rows.length).toBeLessThanOrEqual(2);
      expect((await seriesRow(seriesId)).state).toBe("PAUSED");
      outcomes.add(rows.length === 2 ? "completed first (successor exists)" : "paused first (no successor)");
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1); // either order is valid; both are consistent
  });

  it("completions racing with stopping the series: at most one successor, and nothing is created after the stop", async () => {
    for (let round = 0; round < 8; round++) {
      const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
      const [done, stopped] = await Promise.all([completeTask(ctx("2026-11-03"), task.id), stopSeries(ctx("2026-11-03"), seriesId, 1)]);
      expect(done.ok && stopped.ok).toBe(true);
      expect((await seriesRow(seriesId)).state).toBe("STOPPED");
      const count = await prisma.task.count({ where: { seriesId } });
      expect(count === 1 || count === 2).toBe(true);
      // whatever happened, completing again can never add more
      await undo(task.id);
      await completeTask(ctx("2026-11-20"), task.id);
      expect(await prisma.task.count({ where: { seriesId } })).toBe(count);
    }
  });
});

describe("operations on one series wait for each other (the per-series lock)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Holds the series lock from a separate transaction, starts `operation`, and
  // proves it does not finish until the lock is released.
  async function blockedUntilReleased<T>(seriesId: string, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${seriesId}, 0))`;
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await lockTaken;

    let finished = false;
    const running = operation().then((value) => {
      finished = true;
      return value;
    });
    await sleep(500);
    expect(finished).toBe(false); // still waiting for the lock
    release();
    await holder;
    return running;
  }

  it("completing, pausing, resuming, ending, stopping, editing, turning off and reconciling all wait for it", async () => {
    // complete
    const one = await makeRecurring(userId, { type: "WEEKLY" });
    expect((await blockedUntilReleased(one.seriesId, () => completeTask(ctx("2026-11-03"), one.task.id))).ok).toBe(true);
    expect(await prisma.task.count({ where: { seriesId: one.seriesId } })).toBe(2);

    // pause, resume, end date, edit, stop
    const two = await makeRecurring(userId, { type: "WEEKLY" });
    expect((await blockedUntilReleased(two.seriesId, () => pauseSeries(ctx("2026-11-03"), two.seriesId, 1))).ok).toBe(true);
    expect((await blockedUntilReleased(two.seriesId, () => resumeSeries(ctx("2026-11-03"), two.seriesId, 2))).ok).toBe(true);
    expect((await blockedUntilReleased(two.seriesId, () => setSeriesEndDate(ctx("2026-11-03"), two.seriesId, 3, "2026-12-31"))).ok).toBe(true);
    expect((await blockedUntilReleased(two.seriesId, () => updateSeries(ctx("2026-11-03"), two.seriesId, 4, { title: "Edited" }))).ok).toBe(true);
    expect((await blockedUntilReleased(two.seriesId, () => stopSeries(ctx("2026-11-03"), two.seriesId, 5))).ok).toBe(true);
    expect((await seriesRow(two.seriesId)).version).toBe(6);

    // turn recurrence off for one task
    const three = await makeRecurring(userId, { type: "WEEKLY" });
    expect((await blockedUntilReleased(three.seriesId, () => disableRecurrence(ctx("2026-11-03"), three.task.id, 1))).ok).toBe(true);

    // reconcile an expired pause
    const four = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    await pauseSeries(ctx("2026-11-12"), four.seriesId, 1, "2026-11-24");
    await complete(userId, four.task.id, "2026-11-16");
    const report = await blockedUntilReleased(four.seriesId, () => reconcileExpiredPauses(ctx("2026-11-24", "10:00")));
    expect(report).toMatchObject({ reconciled: 1, failed: [] });
  });

  it("different series do NOT block each other", async () => {
    const one = await makeRecurring(userId, { type: "WEEKLY" });
    const two = await makeRecurring(userId, { type: "WEEKLY" });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${one.seriesId}, 0))`;
      locked();
      await released;
    });
    await lockTaken;
    const result = await completeTask(ctx("2026-11-03"), two.task.id); // finishes while series one is locked
    expect(result.ok).toBe(true);
    release();
    await holder;
  });
});

describe("pause reconciliation and resume racing each other", () => {
  it("8 reconciles and 4 resumes at once produce exactly one instance and one state change", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-11-24");
    await complete(userId, task.id, "2026-11-16");
    expect((await seriesRow(seriesId)).version).toBe(2);

    const at = ctx("2026-11-24", "10:00");
    const calls = await Promise.all([
      ...Array.from({ length: 8 }, () => reconcileExpiredPauses(at)),
      ...Array.from({ length: 4 }, () => resumeSeries(at, seriesId, 2)),
    ]);
    const reports = calls.slice(0, 8) as Array<Awaited<ReturnType<typeof reconcileExpiredPauses>>>;
    expect(reports.every((r) => r.failed.length === 0)).toBe(true);

    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-11-30"]);
    expect(await getSeries(at, seriesId)).toMatchObject({ state: "ACTIVE", pausedUntil: null, version: 3 }); // exactly one transition
  });
});

describe("two browser tabs editing the same series", () => {
  it("of two simultaneous edits made from the same version, exactly one wins and the other gets a typed conflict", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { seriesId } = await makeRecurring(userId, { type: "WEEKLY", title: "Original" });
      const [one, two] = await Promise.all([updateSeries(ctx("2026-11-02"), seriesId, 1, { title: "Tab one" }), updateSeries(ctx("2026-11-02"), seriesId, 1, { title: "Tab two" })]);
      const wins = [one, two].filter((r) => r.ok);
      const losses = [one, two].filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(losses[0]).toMatchObject({ ok: false, error: { code: "CONFLICT", currentVersion: 2 } });
      const winner = wins[0].ok ? wins[0].value.title : "";
      expect((await seriesRow(seriesId)).title).toBe(winner); // the newer data was not overwritten
      expect((await seriesRow(seriesId)).version).toBe(2);
    }
  });

  it("different kinds of series changes made from the same version also cannot overwrite each other", async () => {
    const { seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    const [pause, end, stop] = await Promise.all([
      pauseSeries(ctx("2026-11-02"), seriesId, 1),
      setSeriesEndDate(ctx("2026-11-02"), seriesId, 1, "2026-12-31"),
      updateSeries(ctx("2026-11-02"), seriesId, 1, { title: "Renamed" }),
    ]);
    expect([pause, end, stop].filter((r) => r.ok)).toHaveLength(1);
    expect((await seriesRow(seriesId)).version).toBe(2);
  });
});

describe("a failure in the middle of an operation", () => {
  it("rolls back the completion AND the successor completely, and a retry then works exactly once", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY" });
    await prisma.recurringSeries.update({ where: { id: seriesId }, data: { title: "FAIL_ME" } });
    await installFailTrigger();
    const before = await taskRow(task.id);
    const seriesBefore = await seriesRow(seriesId);

    await expect(completeTask(ctx("2026-11-03"), task.id)).rejects.toThrow(); // the successor insert fails
    expect(await taskRow(task.id)).toEqual(before); // NOT completed: no half-done state
    expect(await prisma.task.count({ where: { seriesId } })).toBe(1);
    expect(await seriesRow(seriesId)).toEqual(seriesBefore);

    await removeFailTrigger(); // the problem goes away; the client retries (for example after a timeout)
    const retried = await completeTask(ctx("2026-11-03"), task.id);
    expect(retried).toMatchObject({ ok: true, value: { alreadyCompleted: false, successor: { occurrenceKey: "2026-11-09" } } });
    const again = await completeTask(ctx("2026-11-03"), task.id);
    expect(again).toMatchObject({ ok: true, value: { alreadyCompleted: true } });
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("a failed pause reconcile is logged without personal data, leaves the series untouched, is not retried at once, and succeeds later", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16", title: "Secret title" });
    await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-11-24");
    await complete(userId, task.id, "2026-11-16");
    await prisma.recurringSeries.update({ where: { id: seriesId }, data: { title: "FAIL_ME", description: "private notes" } });
    await installFailTrigger();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await reconcileExpiredPauses(ctx("2026-11-24", "00:00"));
    expect(first).toMatchObject({ reconciled: 0, failed: [{ seriesId, code: "RECONCILE_FAILED" }], skippedByBackoff: 0 });
    expect(await seriesRow(seriesId)).toMatchObject({ state: "PAUSED", version: 2 }); // rolled back completely
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16"]);

    expect(log).toHaveBeenCalledTimes(1); // the failure is NOT silent …
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: "recurrence.reconcile_failed", seriesId, userId });
    for (const secret of ["FAIL_ME", "Secret title", "private notes", "simulated failure"]) expect(line).not.toContain(secret); // … but never logs personal data

    const soon = ctxFor(userId, "2026-11-24", "00:00");
    soon.now = new Date(soon.now!.getTime() + 30_000);
    expect(await reconcileExpiredPauses(soon)).toMatchObject({ reconciled: 0, failed: [], skippedByBackoff: 1 }); // not hammered
    expect(log).toHaveBeenCalledTimes(1);

    await removeFailTrigger();
    const later = ctxFor(userId, "2026-11-24", "00:00");
    later.now = new Date(later.now!.getTime() + RECONCILE_BACKOFF_MS + 1000);
    expect(await reconcileExpiredPauses(later)).toMatchObject({ reconciled: 1, failed: [] }); // retried safely
    expect(keysOf(await instancesOf(seriesId))).toEqual(["2026-11-16", "2026-11-30"]);
    expect(await seriesRow(seriesId)).toMatchObject({ state: "ACTIVE", version: 3 });
    expect(await reconcileExpiredPauses(later)).toMatchObject({ reconciled: 0 }); // and only once
  });

  it("inside a user operation, a failed reconcile aborts the operation with a typed error instead of being ignored", async () => {
    const { task, seriesId } = await makeRecurring(userId, { type: "WEEKLY", plannedDate: "2026-11-16" });
    await pauseSeries(ctx("2026-11-12"), seriesId, 1, "2026-11-24");
    await complete(userId, task.id, "2026-11-16");
    await prisma.recurringSeries.update({ where: { id: seriesId }, data: { title: "FAIL_ME" } });
    await installFailTrigger();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await pauseSeries(ctx("2026-11-25"), seriesId, 2, "2026-12-30");
    expect(result).toMatchObject({ ok: false, error: { code: "RECONCILE_FAILED" } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(await seriesRow(seriesId)).toMatchObject({ state: "PAUSED", version: 2 }); // nothing changed
    expect(await prisma.task.count({ where: { seriesId } })).toBe(1);
  });
});
