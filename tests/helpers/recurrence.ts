// Helpers for the recurrence integration tests.

import { dateFromDb, timeFromDb } from "@/lib/local-time";
import { completeTask, convertToRecurring } from "@/lib/recurrence/service";
import type { ConvertInput } from "@/lib/recurrence/validation";

import { createTask, ctxFor, prisma } from "./db";

export type Setup = Parameters<typeof createTask>[1] & ConvertInput;

// Creates an ordinary task and turns it into the first instance of a series.
export async function makeRecurring(userId: string, options: Setup = { type: "WEEKLY" }) {
  const { type, weekdays, endDate, ...task } = options;
  const created = await createTask(userId, { plannedDate: "2026-11-02", ...task });
  const result = await convertToRecurring(ctxFor(userId), created.id, { type, weekdays, endDate });
  if (!result.ok) throw new Error(`setup failed: ${result.error.code} ${result.error.message}`);
  return { task: created, seriesId: result.value.seriesId, version: result.value.version, successor: result.value.successor };
}

export async function complete(userId: string, taskId: string, date: string, time = "12:00") {
  const result = await completeTask(ctxFor(userId, date, time), taskId);
  if (!result.ok) throw new Error(`complete failed: ${result.error.code}`);
  return result.value;
}

// What "Undo Complete" does in the app: back to unfinished, nothing else.
export const undo = (taskId: string, status: "TODO" | "IN_PROGRESS" = "TODO") =>
  prisma.task.update({ where: { id: taskId }, data: { status, completedAt: null } });

export const dates = (row: { plannedDate: Date | null; plannedTime: Date | null; deadlineDate: Date | null; deadlineTime: Date | null; originalDeadlineDate: Date | null }) => ({
  planned: [dateFromDb(row.plannedDate), timeFromDb(row.plannedTime)],
  deadline: [dateFromDb(row.deadlineDate), timeFromDb(row.deadlineTime)],
  original: dateFromDb(row.originalDeadlineDate),
});

export const seriesRow = (id: string) => prisma.recurringSeries.findUniqueOrThrow({ where: { id } });
export const taskRow = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
