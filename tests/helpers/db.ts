// Helpers shared by the integration tests. Everything here runs against the
// separate test database only (see tests/setup).

import { randomBytes } from "node:crypto";

import type { Priority, TaskStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { dateToDb, timeToDb } from "@/lib/local-time";
import { RECURRENCE_TIME_ZONE } from "@/lib/recurrence/rules";
import { wallClockToInstant } from "@/lib/recurrence/zoned-time";
import type { ServiceContext } from "@/lib/recurrence/types";

export { prisma };

// Second line of defence: before anything destructive, ask the server which
// database we are really connected to.
export async function assertTestDatabase() {
  const [row] = await prisma.$queryRaw<Array<{ name: string }>>`select current_database() as name`;
  if (!row.name.endsWith("_test")) throw new Error(`Connected to "${row.name}", which is not a test database. Stopping.`);
}

// Empties every table (TRUNCATE ... CASCADE follows the foreign keys).
export async function resetDatabase() {
  await assertTestDatabase();
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE users CASCADE`);
}

// Ids that satisfy the app's id format (lower-case letters and digits, 20-40 long).
export const newId = (prefix = "x") => `${prefix}${randomBytes(12).toString("hex")}`.slice(0, 25);

export async function createUser(label = "user") {
  const id = newId("u");
  await prisma.user.create({ data: { id, name: label, email: `${id}@example.invalid` } });
  return id;
}

export async function createCategory(userId: string, name = "Cat", color: "TEAL" | "PINK" | "RED" = "TEAL") {
  return prisma.category.create({ data: { id: newId("c"), userId, name, normalizedName: name.toLowerCase(), color } });
}

type TaskOptions = {
  title?: string;
  status?: TaskStatus;
  priority?: Priority;
  description?: string | null;
  plannedDate?: string | null;
  plannedTime?: string | null;
  deadlineDate?: string | null;
  deadlineTime?: string | null;
  estimatedMinutes?: number | null;
  categoryId?: string | null;
  rescheduleCount?: number;
  completedAt?: Date | null;
  createdAt?: Date;
};

export async function createTask(userId: string, o: TaskOptions = {}) {
  return prisma.task.create({
    data: {
      id: newId("t"),
      userId,
      title: o.title ?? "Task",
      description: o.description ?? null,
      status: o.status ?? "TODO",
      priority: o.priority ?? "MEDIUM",
      plannedDate: dateToDb(o.plannedDate ?? null),
      plannedTime: timeToDb(o.plannedTime ?? null),
      deadlineDate: dateToDb(o.deadlineDate ?? null),
      deadlineTime: timeToDb(o.deadlineTime ?? null),
      originalDeadlineDate: dateToDb(o.deadlineDate ?? null),
      estimatedMinutes: o.estimatedMinutes ?? null,
      categoryId: o.categoryId ?? null,
      rescheduleCount: o.rescheduleCount ?? 0,
      completedAt: o.completedAt !== undefined ? o.completedAt : o.status === "COMPLETED" ? new Date("2026-10-01T10:00:00Z") : null,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  });
}

// A fixed moment, written as Tallinn wall-clock time: at("2026-11-12", "10:00").
export const at = (date: string, time = "12:00") => new Date(wallClockToInstant(date, time, RECURRENCE_TIME_ZONE));

export const ctxFor = (userId: string, date = "2026-11-02", time = "12:00"): ServiceContext => ({ userId, now: at(date, time) });

// The keys of a series' instances, in order, with their statuses.
export async function instancesOf(seriesId: string) {
  const rows = await prisma.task.findMany({ where: { seriesId }, orderBy: { occurrenceKey: "asc" } });
  return rows;
}
export const keysOf = (rows: Array<{ occurrenceKey: string | null }>) => rows.map((r) => r.occurrenceKey);
