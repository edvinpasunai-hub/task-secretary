"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { archiveTask, deleteTaskForever, emptyTrash, restoreTask, trashTask, trashTaskAndFuture, unarchiveTask } from "@/lib/trash/service";
import type { RecurrenceError } from "@/lib/recurrence/types";
import { idSchema } from "@/lib/recurrence/validation";
import { requireUser } from "@/lib/session";

// Trash and archive actions. Server Actions are public endpoints: each one resolves the logged-in
// user itself, accepts only plain ids, and the service only touches that user's tasks.
// After a change every page (and the reminder bell) is refreshed.

export type TrashActionResult = { ok: true; message: string } | { ok: false; message: string };

const taskInput = z.object({ taskId: idSchema }).strict();
const futureInput = z.object({ taskId: idSchema, version: z.number().int().min(1) }).strict();

const failure = (error: RecurrenceError): TrashActionResult => ({ ok: false, message: error.message });
const BAD_INPUT: TrashActionResult = { ok: false, message: "This task was not found." };
const done = (message: string): TrashActionResult => {
  revalidatePath("/", "layout");
  return { ok: true, message };
};

export async function moveToTrashAction(input: unknown): Promise<TrashActionResult> {
  const user = await requireUser();
  const parsed = taskInput.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await trashTask({ userId: user.id }, parsed.data.taskId);
  return result.ok ? done("Moved to Trash.") : failure(result.error);
}

// "This and future tasks": stops the series for good and trashes its unfinished tasks.
export async function moveSeriesToTrashAction(input: unknown): Promise<TrashActionResult> {
  const user = await requireUser();
  const parsed = futureInput.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await trashTaskAndFuture({ userId: user.id }, parsed.data.taskId, parsed.data.version);
  return result.ok ? done("The series was stopped and its unfinished tasks were moved to Trash.") : failure(result.error);
}

export async function restoreFromTrashAction(input: unknown): Promise<TrashActionResult> {
  const user = await requireUser();
  const parsed = taskInput.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await restoreTask({ userId: user.id }, parsed.data.taskId);
  // Even a refused restore (expired) refreshes the page, so the task disappears from the list.
  if (!result.ok) revalidatePath("/", "layout");
  return result.ok ? done("Task restored.") : failure(result.error);
}

export async function archiveTaskAction(input: unknown): Promise<TrashActionResult> {
  const user = await requireUser();
  const parsed = taskInput.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await archiveTask({ userId: user.id }, parsed.data.taskId);
  return result.ok ? done("Task archived.") : failure(result.error);
}

export async function unarchiveTaskAction(input: unknown): Promise<TrashActionResult> {
  const user = await requireUser();
  const parsed = taskInput.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await unarchiveTask({ userId: user.id }, parsed.data.taskId);
  return result.ok ? done("Task restored to your list.") : failure(result.error);
}

export async function deleteForeverAction(input: unknown): Promise<TrashActionResult> {
  const user = await requireUser();
  const parsed = taskInput.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await deleteTaskForever({ userId: user.id }, parsed.data.taskId);
  return result.ok ? done("Task deleted permanently.") : failure(result.error);
}

export async function emptyTrashAction(): Promise<TrashActionResult> {
  const user = await requireUser();
  const { removed } = await emptyTrash({ userId: user.id });
  return done(removed === 1 ? "1 task deleted permanently." : `${removed} tasks deleted permanently.`);
}
