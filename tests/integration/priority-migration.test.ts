// Stage 6.1 migration compatibility: "Importance" (HIGH / NORMAL / LOW) becomes "Priority" (HIGH / MEDIUM / LOW).
// The migration is applied to a SCRATCH database (created here, named "..._priority_migration_test", dropped
// afterwards; never the development database) that first holds data in the OLD schema, so the exact SQL that
// the real database will run is proven against existing tasks, repeating series, trashed, archived and
// occurrence rows.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminUrlFor, assertSafeTestUrl, databaseNameOf, testDatabaseUrl } from "../setup/test-db";

const NEW_MIGRATION = "20261030120000_task_priority";
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const MAP: Record<string, string> = { HIGH: "HIGH", NORMAL: "MEDIUM", LOW: "LOW" };

const base = new URL(testDatabaseUrl());
const SCRATCH = `${databaseNameOf(base.toString()).replace(/_test$/, "")}_priority_migration_test`;
const scratchUrl = (() => {
  const url = new URL(base);
  url.pathname = `/${SCRATCH}`;
  return url;
})();

let admin: pg.Client;
let db: pg.Client;
const expectedTask = new Map<string, string>();
const expectedSeries = new Map<string, string>();
let before: { snapshot: string; tasks: number; series: number; constraints: number; indexes: number; oldValues: Array<{ id: string; v: string }> };
let newSql = "";

async function otherColumns(table: string) {
  const rows = (await db.query(`select column_name from information_schema.columns where table_name = $1 and column_name not in ('importance','priority') order by ordinal_position`, [table])).rows;
  return rows.map((r) => `"${r.column_name}"`).join(", ");
}
// Everything EXCEPT the renamed column, so "nothing else changed" is checked byte for byte.
async function snapshot() {
  const parts: unknown[] = [];
  for (const table of ["tasks", "recurring_series"]) parts.push((await db.query(`select ${await otherColumns(table)} from ${table} order by id`)).rows);
  for (const table of ["users", "categories", "reminders", "accounts", "sessions"]) parts.push((await db.query(`select * from ${table} order by id`)).rows);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
const count = async (sql: string) => Number((await db.query(sql)).rows[0].count);
const constraints = () => count(`select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname in ('tasks','recurring_series')`);
const indexes = () => count(`select count(*) from pg_indexes where tablename in ('tasks','recurring_series')`);

beforeAll(async () => {
  assertSafeTestUrl(scratchUrl); // refuses anything that is not a local "*_test" database
  admin = new pg.Client({ connectionString: adminUrlFor(base.toString()) });
  await admin.connect();
  await admin.query(`drop database if exists "${SCRATCH}" with (force)`);
  await admin.query(`create database "${SCRATCH}"`);
  db = new pg.Client({ connectionString: scratchUrl.toString() });
  await db.connect();

  // The schema as it was before this migration: every earlier migration, in order.
  const names = readdirSync(MIGRATIONS).filter((n) => /^\d{14}_/.test(n)).sort();
  for (const name of names.filter((n) => n < NEW_MIGRATION)) await db.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
  newSql = readFileSync(join(MIGRATIONS, NEW_MIGRATION, "migration.sql"), "utf8");

  // Existing data in the OLD schema: every importance, every status, two users.
  await db.query(`insert into users (id, name, email, "updatedAt") values ('ua', 'A', 'a@example.invalid', now()), ('ub', 'B', 'b@example.invalid', now())`);
  await db.query(`insert into categories (id, "userId", name, "normalizedName", color, "updatedAt") values ('ca', 'ua', 'Work', 'work', 'TEAL', now())`);
  let n = 0;
  for (const importance of ["HIGH", "NORMAL", "LOW"]) {
    for (const status of ["TODO", "IN_PROGRESS", "POSTPONED", "COMPLETED"]) {
      const id = `t${n++}`;
      await db.query(
        `insert into tasks (id, "userId", title, description, importance, status, "plannedDate", "deadlineDate", "deadlineTime", "originalDeadlineDate", "rescheduleCount", "estimatedMinutes", "completedAt", "categoryId", "updatedAt")
         values ($1, $2, $3, 'd', $4::"Importance", $5::"TaskStatus", '2026-11-09', '2026-11-12', '17:00', '2026-11-10', 2, 90, $6, $7, now())`,
        [id, n % 2 ? "ua" : "ub", `Task ${id}`, importance, status, status === "COMPLETED" ? new Date("2026-10-01T10:00:00Z") : null, n % 2 ? "ca" : null],
      );
      expectedTask.set(id, MAP[importance]);
    }
  }
  await db.query(`insert into tasks (id, "userId", title, "updatedAt") values ('tdefault', 'ua', 'Created with the old default', now())`);
  expectedTask.set("tdefault", "MEDIUM");
  await db.query(`update tasks set "deletedAt" = now() at time zone 'UTC' where id = 't1'`); // in Trash
  await db.query(`update tasks set "archivedAt" = now() at time zone 'UTC' where id = 't3'`); // archived
  let s = 0;
  for (const importance of ["HIGH", "NORMAL", "LOW"]) {
    const id = `s${s++}`;
    await db.query(`insert into recurring_series (id, "userId", type, weekdays, "anchorDate", title, importance, state, version, "updatedAt") values ($1, 'ua', 'WEEKLY', '{1}', '2026-11-02', $2, $3::"Importance", 'ACTIVE', 1, now())`, [id, `Series ${id}`, importance]);
    expectedSeries.set(id, MAP[importance]);
  }
  await db.query(`insert into recurring_series (id, "userId", type, weekdays, "anchorDate", title, state, version, "updatedAt") values ('sdefault', 'ua', 'WEEKLY', '{2}', '2026-11-03', 'Series with the old default', 'ACTIVE', 1, now())`);
  expectedSeries.set("sdefault", "MEDIUM");
  await db.query(`insert into tasks (id, "userId", title, importance, "seriesId", "occurrenceKey", "updatedAt") values ('toccurrence', 'ua', 'Occurrence', 'HIGH', 's0', '2026-11-02', now())`);
  expectedTask.set("toccurrence", "HIGH");
  await db.query(`insert into reminders (id, "taskId", "userId", type, "forDueDate", "scheduledAt", "updatedAt") values ('r1', 't0', 'ua', 'DUE_DAY', '2026-11-12', '2026-11-12 07:00', now())`);

  before = {
    snapshot: await snapshot(),
    tasks: await count(`select count(*) from tasks`),
    series: await count(`select count(*) from recurring_series`),
    constraints: await constraints(),
    indexes: await indexes(),
    oldValues: (await db.query(`select id, importance::text v from tasks`)).rows,
  };
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await admin?.query(`drop database if exists "${SCRATCH}" with (force)`).catch(() => undefined);
  await admin?.end().catch(() => undefined);
});

describe("the migration, step by step on a database that holds existing data", () => {
  it("is all-or-nothing: a failure in the middle changes nothing (old column, old type and old values stay)", async () => {
    await expect(db.query(newSql.replace("COMMIT;", "SELECT 1/0;\nCOMMIT;"))).rejects.toThrow();
    await db.query("ROLLBACK").catch(() => undefined);
    const columns = (await db.query(`select column_name from information_schema.columns where table_name = 'tasks' and column_name in ('importance','priority')`)).rows.map((r) => r.column_name);
    expect(columns).toEqual(["importance"]);
    expect(await count(`select count(*) from pg_type where typname = 'Importance'`)).toBe(1);
    expect(await count(`select count(*) from pg_type where typname = 'Priority'`)).toBe(0);
    expect(await snapshot()).toBe(before.snapshot);
    expect((await db.query(`select importance::text v from tasks where id = 't4'`)).rows[0].v).toBe("NORMAL");
  });

  it("runs", async () => {
    await db.query(newSql);
    expect(await count(`select count(*) from pg_type where typname = 'Priority'`)).toBe(1);
  });

  it("every existing task keeps its level: HIGH -> HIGH, NORMAL -> MEDIUM, LOW -> LOW (nothing lost)", async () => {
    const tasks = (await db.query(`select id, priority::text v from tasks`)).rows as Array<{ id: string; v: string }>;
    expect(tasks).toHaveLength(before.tasks);
    for (const task of tasks) expect(task.v, task.id).toBe(expectedTask.get(task.id));
    for (const old of before.oldValues) expect(tasks.find((t) => t.id === old.id)?.v).toBe(MAP[old.v]);
  });

  it("tasks that were created with the old default (never given a level) are now MEDIUM", async () => {
    expect((await db.query(`select priority::text v from tasks where id = 'tdefault'`)).rows[0].v).toBe("MEDIUM");
  });

  it("trashed, archived and repeating-occurrence tasks keep their level too", async () => {
    for (const id of ["t1", "t3", "toccurrence"]) expect((await db.query(`select priority::text v from tasks where id = $1`, [id])).rows[0].v, id).toBe(expectedTask.get(id));
  });

  it("every repeating series keeps its template level (so future occurrences keep copying it)", async () => {
    const series = (await db.query(`select id, priority::text v from recurring_series`)).rows as Array<{ id: string; v: string }>;
    expect(series).toHaveLength(before.series);
    for (const row of series) expect(row.v, row.id).toBe(expectedSeries.get(row.id));
  });

  it("everything else is byte-for-byte unchanged: tasks, series, users, categories, reminders, accounts", async () => {
    expect(await snapshot()).toBe(before.snapshot);
  });

  it("no constraint and no index was lost", async () => {
    expect(await constraints()).toBe(before.constraints);
    expect(await indexes()).toBe(before.indexes);
  });

  it("the columns are now 'priority': NOT NULL, default MEDIUM, type Priority; there is no 'importance' column", async () => {
    const rows = (await db.query(`select table_name t, column_name c, column_default d, is_nullable n, udt_name u from information_schema.columns where table_name in ('tasks','recurring_series') and column_name in ('importance','priority')`)).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.c).toBe("priority");
      expect(row.n).toBe("NO");
      expect(row.u).toBe("Priority");
      expect(row.d).toMatch(/MEDIUM/);
    }
  });

  it("the enum is exactly HIGH, MEDIUM, LOW in that order, and the old type is gone", async () => {
    expect((await db.query(`select string_agg(enumlabel, ',' order by enumsortorder) l from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'Priority'`)).rows[0].l).toBe("HIGH,MEDIUM,LOW");
    expect(await count(`select count(*) from pg_type where typname = 'Importance'`)).toBe(0);
  });

  it("a new task without a priority gets MEDIUM; NORMAL and any other value are refused by the database", async () => {
    await db.query(`insert into tasks (id, "userId", title, "updatedAt") values ('tnew', 'ub', 'New task', now())`);
    expect((await db.query(`select priority::text v from tasks where id = 'tnew'`)).rows[0].v).toBe("MEDIUM");
    for (const value of ["NORMAL", "URGENT", "high", ""]) {
      await expect(db.query(`update tasks set priority = $1::"Priority" where id = 'tnew'`, [value]), value).rejects.toThrow();
    }
  });

  it("sorting by priority puts HIGH first and LOW last (the order the app relies on)", async () => {
    const order = (await db.query(`select array_agg(priority::text order by priority, id) o from tasks`)).rows[0].o as string[];
    expect(order[0]).toBe("HIGH");
    expect(order[order.length - 1]).toBe("LOW");
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    for (let i = 1; i < order.length; i++) expect(rank[order[i] as keyof typeof rank]).toBeGreaterThanOrEqual(rank[order[i - 1] as keyof typeof rank]);
  });
});
