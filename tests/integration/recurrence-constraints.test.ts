// What the DATABASE itself refuses, whatever the application code does. These use
// plain SQL on purpose, so a bug in the service layer cannot hide a missing rule.

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertTestDatabase, createCategory, createTask, createUser, newId, prisma, resetDatabase } from "../helpers/db";

const CHECK = "23514";
const FOREIGN_KEY = "23503";
const UNIQUE = "23505";

let db: pg.Client;
beforeAll(async () => {
  await assertTestDatabase();
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});
afterAll(async () => {
  await db.end();
  await prisma.$disconnect();
});
beforeEach(resetDatabase);

async function refused(query: string, params: unknown[], code: string) {
  try {
    await db.query(query, params);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`the database accepted: ${query.slice(0, 80)}`);
}

type SeriesOptions = Partial<{ type: string; weekdays: string; monthlyDay: number | null; anchorDate: string; endDate: string | null; state: string; pausedUntil: string | null; deadlineOffsetDays: number | null; deadlineTime: string | null; version: number; categoryId: string | null }>;

function seriesInsert(id: string, userId: string, o: SeriesOptions = {}): [string, unknown[]] {
  const v = { type: "WEEKLY", weekdays: "{1}", monthlyDay: null, anchorDate: "2026-11-02", endDate: null, state: "ACTIVE", pausedUntil: null, deadlineOffsetDays: null, deadlineTime: null, version: 1, categoryId: null, ...o };
  return [
    `insert into recurring_series (id, "userId", type, weekdays, "monthlyDay", "anchorDate", title, "categoryId", "deadlineOffsetDays", "deadlineTime", "endDate", state, "pausedUntil", version, "updatedAt")
     values ($1, $2, $3::"RecurrenceType", $4::int[], $5, $6, 'Series', $7, $8, $9, $10, $11::"SeriesState", $12, $13, now())`,
    [id, userId, v.type, v.weekdays, v.monthlyDay, v.anchorDate, v.categoryId, v.deadlineOffsetDays, v.deadlineTime, v.endDate, v.state, v.pausedUntil, v.version],
  ];
}

function taskInsert(id: string, userId: string, seriesId: string | null, key: string | null, predecessorId: string | null = null): [string, unknown[]] {
  return [`insert into tasks (id, "userId", title, "seriesId", "occurrenceKey", "predecessorId", "updatedAt") values ($1, $2, 'inst', $3, $4, $5, now())`, [id, userId, seriesId, key, predecessorId]];
}

describe("recurring_series rules", () => {
  it("accepts every valid shape", async () => {
    const user = await createUser();
    for (const [i, o] of [
      { type: "DAILY", weekdays: "{}" },
      { type: "WEEKLY", weekdays: "{3}" },
      { type: "MONTHLY", weekdays: "{}", monthlyDay: 31 },
      { type: "CUSTOM_WEEKDAYS", weekdays: "{1,3,5}" },
      { type: "CUSTOM_WEEKDAYS", weekdays: "{1,2,3,4,5,6,7}" },
      { state: "PAUSED", pausedUntil: "2026-12-01" },
      { state: "PAUSED", pausedUntil: null },
      { endDate: "2026-11-02" },
      { deadlineOffsetDays: -3650, deadlineTime: "09:00" },
      { deadlineOffsetDays: 3650 },
    ].entries()) {
      await db.query(...seriesInsert(newId(`s${i}`), user, o));
    }
    expect(await prisma.recurringSeries.count()).toBe(10);
  });

  it.each([
    ["WEEKLY with two weekdays", { weekdays: "{1,2}" }],
    ["WEEKLY with no weekday", { weekdays: "{}" }],
    ["CUSTOM_WEEKDAYS with none", { type: "CUSTOM_WEEKDAYS", weekdays: "{}" }],
    ["weekday 0", { type: "CUSTOM_WEEKDAYS", weekdays: "{0,1}" }],
    ["weekday 8", { type: "CUSTOM_WEEKDAYS", weekdays: "{1,8}" }],
    ["DAILY with a weekday", { type: "DAILY", weekdays: "{1}" }],
    ["MONTHLY without a day", { type: "MONTHLY", weekdays: "{}", monthlyDay: null }],
    ["MONTHLY day 0", { type: "MONTHLY", weekdays: "{}", monthlyDay: 0 }],
    ["MONTHLY day 32", { type: "MONTHLY", weekdays: "{}", monthlyDay: 32 }],
    ["MONTHLY with a weekday", { type: "MONTHLY", weekdays: "{1}", monthlyDay: 5 }],
    ["WEEKLY with a day of the month", { monthlyDay: 5 }],
    ["end date before the first planned date", { endDate: "2026-11-01" }],
    ["pausedUntil while ACTIVE", { pausedUntil: "2026-12-01" }],
    ["pausedUntil while ENDED", { state: "ENDED", pausedUntil: "2026-12-01" }],
    ["deadline time without a deadline", { deadlineTime: "17:00" }],
    ["deadline offset above the limit", { deadlineOffsetDays: 3651 }],
    ["deadline offset below the limit", { deadlineOffsetDays: -3651 }],
    ["version 0", { version: 0 }],
  ] as Array<[string, SeriesOptions]>)("refuses: %s", async (_label, options) => {
    const user = await createUser();
    await refused(...seriesInsert(newId("s"), user, options), CHECK);
  });

  it("refuses a series without weekdays at all (NULL must not slip past a CHECK)", async () => {
    const user = await createUser();
    await refused(`insert into recurring_series (id, "userId", type, "anchorDate", title, "updatedAt") values ($1, $2, 'DAILY', '2026-11-02', 'x', now())`, [newId("s"), user], CHECK);
  });

  it("refuses an unknown owner and an unknown category", async () => {
    const user = await createUser();
    await refused(...seriesInsert(newId("s"), "nobody"), FOREIGN_KEY);
    await refused(...seriesInsert(newId("s"), user, { categoryId: "nope" }), FOREIGN_KEY);
  });
});

describe("tasks of a series", () => {
  it("accepts instances and links them", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const a = newId("a");
    await db.query(...taskInsert(a, user, seriesId, "2026-11-02"));
    await db.query(...taskInsert(newId("b"), user, seriesId, "2026-11-09", a));
    await db.query(...taskInsert(newId("c"), user, seriesId, "2026-11-16T09:00"));
    expect(await prisma.task.count({ where: { seriesId } })).toBe(3);
  });

  it("many ordinary tasks may have no series and no key (NULLs do not collide)", async () => {
    const user = await createUser();
    for (let i = 0; i < 5; i++) await db.query(...taskInsert(newId("t"), user, null, null));
    expect(await prisma.task.count()).toBe(5);
  });

  it.each([
    ["a series without an occurrence key", (s: string) => [null as string | null, s] as const, CHECK],
  ])("refuses %s", async (_label, build, code) => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const [key, series] = build(seriesId);
    await refused(...taskInsert(newId("t"), user, series, key), code);
  });

  it("refuses an occurrence key without a series, and malformed keys", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    await refused(...taskInsert(newId("t"), user, null, "2026-11-02"), CHECK);
    for (const key of ["2026-11-02 09:00", "2026-11-02T09:00:00", "02-11-2026", "2026-11-02T9:00", "", "x", "2026-11-02T"]) {
      await refused(...taskInsert(newId("t"), user, seriesId, key), CHECK);
    }
  });

  it("refuses a task as its own predecessor and a missing predecessor", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const id = newId("t");
    await refused(...taskInsert(id, user, seriesId, "2026-11-02", id), CHECK);
    await refused(...taskInsert(newId("t"), user, seriesId, "2026-11-09", "ghost"), FOREIGN_KEY);
  });

  it("the same occurrence can never exist twice in one series, but may in another", async () => {
    const user = await createUser();
    const s1 = newId("s");
    const s2 = newId("s");
    await db.query(...seriesInsert(s1, user));
    await db.query(...seriesInsert(s2, user));
    await db.query(...taskInsert(newId("t"), user, s1, "2026-11-02"));
    await refused(...taskInsert(newId("t"), user, s1, "2026-11-02"), UNIQUE);
    await db.query(...taskInsert(newId("t"), user, s2, "2026-11-02"));
  });

  it("an instance can have only ONE successor", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const a = newId("a");
    await db.query(...taskInsert(a, user, seriesId, "2026-11-02"));
    await db.query(...taskInsert(newId("b"), user, seriesId, "2026-11-09", a));
    await refused(...taskInsert(newId("c"), user, seriesId, "2026-11-16", a), UNIQUE);
  });

  it("a task can only belong to a series of ITS OWN user", async () => {
    const owner = await createUser("owner");
    const stranger = await createUser("stranger");
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, owner));
    await refused(...taskInsert(newId("t"), stranger, seriesId, "2026-11-02"), FOREIGN_KEY);
    // moving an existing task into someone else's series is refused too
    const task = await createTask(stranger);
    await refused(`update tasks set "seriesId" = $1, "occurrenceKey" = '2026-11-02' where id = $2`, [seriesId, task.id], FOREIGN_KEY);
    // No application code changes a series' owner. If it were done directly in the
    // database, the instances follow their series (the key is ON UPDATE CASCADE),
    // so a task and its series can never end up with different owners.
    await db.query(...taskInsert(newId("t"), owner, seriesId, "2026-11-02"));
    await db.query(`update recurring_series set "userId" = $1 where id = $2`, [stranger, seriesId]);
    const diverged = await db.query(`select count(*)::int as n from tasks t join recurring_series s on s.id = t."seriesId" where t."userId" <> s."userId"`);
    expect(diverged.rows[0].n).toBe(0);
    expect((await prisma.task.findFirstOrThrow({ where: { seriesId } })).userId).toBe(stranger);
  });

  it("an unknown series is refused", async () => {
    const user = await createUser();
    await refused(...taskInsert(newId("t"), user, "ghost", "2026-11-02"), FOREIGN_KEY);
  });
});

describe("what happens when things are deleted", () => {
  it("deleting a category clears it on the series and on tasks, and keeps both", async () => {
    const user = await createUser();
    const category = await createCategory(user);
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user, { categoryId: category.id }));
    const task = await createTask(user, { categoryId: category.id });
    await prisma.category.delete({ where: { id: category.id } });
    expect((await prisma.recurringSeries.findUniqueOrThrow({ where: { id: seriesId } })).categoryId).toBeNull();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).categoryId).toBeNull();
  });

  it("deleting a task only clears the link on its successor", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const a = newId("a");
    const b = newId("b");
    await db.query(...taskInsert(a, user, seriesId, "2026-11-02"));
    await db.query(...taskInsert(b, user, seriesId, "2026-11-09", a));
    await db.query(`delete from tasks where id = $1`, [a]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: b } })).predecessorId).toBeNull();
  });

  it("a series that still has tasks cannot be deleted by itself (history stays valid)", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    await db.query(...taskInsert(newId("t"), user, seriesId, "2026-11-02"));
    await refused(`delete from recurring_series where id = $1`, [seriesId], FOREIGN_KEY);
  });

  it("deleting a user removes their series and tasks, and nobody else's", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    for (const user of [a, b]) {
      const seriesId = newId("s");
      await db.query(...seriesInsert(seriesId, user));
      await db.query(...taskInsert(newId("t"), user, seriesId, "2026-11-02"));
    }
    await prisma.user.delete({ where: { id: a } });
    expect(await prisma.recurringSeries.count({ where: { userId: a } })).toBe(0);
    expect(await prisma.task.count({ where: { userId: a } })).toBe(0);
    expect(await prisma.recurringSeries.count({ where: { userId: b } })).toBe(1);
    expect(await prisma.task.count({ where: { userId: b } })).toBe(1);
  });
});

describe("simultaneous inserts of the same occurrence or successor", () => {
  it("20 parallel attempts to create the same occurrence: exactly one row", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => prisma.task.create({ data: { id: newId("t"), userId: user, title: "dup", seriesId, occurrenceKey: "2026-11-09" } })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason?.code === "P2002")).toBe(true);
  });

  it("20 parallel attempts to give one instance a successor: exactly one", async () => {
    const user = await createUser();
    const seriesId = newId("s");
    await db.query(...seriesInsert(seriesId, user));
    const a = newId("a");
    await db.query(...taskInsert(a, user, seriesId, "2026-11-02"));
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => prisma.task.create({ data: { id: newId("t"), userId: user, title: "next", seriesId, occurrenceKey: `2026-12-${String(i + 1).padStart(2, "0")}`, predecessorId: a } })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
