"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { categoryIdSchema } from "@/lib/category-validation";
import { prisma } from "@/lib/db";
import { dateFromDb, dateToDb, timeToDb } from "@/lib/local-time";
import { completeTask, completeTaskInTx } from "@/lib/recurrence/service";
import { requireUser } from "@/lib/session";
import { applyDeadlineChange, completedAtFor } from "@/lib/task-rules";
import {
  parseTaskForm,
  taskIdSchema,
  taskStatusSchema,
  type TaskFormField,
  type TaskFormValues,
  type TaskInput,
} from "@/lib/task-validation";

// Server Actions are public endpoints: every action checks the session itself
// and only ever touches rows where userId is the logged-in user's id. A userId
// sent by the browser is never read.

export type TaskFormState = {
  errors?: Partial<Record<TaskFormField, string>>;
  message?: string;
  values?: TaskFormValues;
};

function taskColumns(input: TaskInput) {
  return {
    categoryId: input.categoryId,
    title: input.title,
    description: input.description,
    importance: input.importance,
    plannedDate: dateToDb(input.plannedDate),
    plannedTime: timeToDb(input.plannedTime),
    deadlineDate: dateToDb(input.deadlineDate),
    deadlineTime: timeToDb(input.deadlineTime),
    estimatedMinutes: input.estimatedMinutes,
  };
}

const SAVE_FAILED = "Sorry, the task could not be saved. Please try again.";
const CATEGORY_INVALID = "Please choose one of your categories.";

// A category id sent by the browser is only accepted if the category belongs to
// the logged-in user. Someone else's category and an unknown id look exactly
// the same: both are simply "not one of your categories".
async function ownsCategory(userId: string, categoryId: string | null) {
  if (categoryId === null) return true;
  return (await prisma.category.count({ where: { id: categoryId, userId } })) === 1;
}

// Where to go after saving an edit. The browser only sends a category id; the
// path is built here, and only if that id is one of the user's own categories.
// Anything else (an URL, a deleted or someone else's category) goes to the plain list.
async function returnPath(userId: string, raw: FormDataEntryValue | null) {
  const id = categoryIdSchema.safeParse(raw);
  if (!id.success || !(await ownsCategory(userId, id.data))) return "/";
  return `/?category=${id.data}`;
}

// The category was deleted between the check and the save.
const isMissingCategory = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2003";

export async function createTask(_state: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const user = await requireUser();
  const parsed = parseTaskForm(formData);
  if (!parsed.success) return { errors: parsed.errors, values: parsed.values };

  try {
    if (!(await ownsCategory(user.id, parsed.data.categoryId))) {
      return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values };
    }
    await prisma.task.create({
      data: {
        ...taskColumns(parsed.data),
        userId: user.id,
        originalDeadlineDate: dateToDb(parsed.data.deadlineDate),
      },
    });
  } catch (error) {
    if (isMissingCategory(error)) return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values };
    return { message: SAVE_FAILED };
  }
  redirect("/");
}

// Saves the edit form. When the form also sends a "status" (the "Save changes
// and switch status" choice), the edits and the new status are saved together
// in one update and the user stays on the task page; if the edits are invalid,
// nothing is saved and the status stays as it was.
export async function updateTask(_state: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const user = await requireUser();
  const id = taskIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: "This task was not found." };

  const requestedStatus = formData.get("status");
  const status = requestedStatus === null ? null : taskStatusSchema.safeParse(requestedStatus);
  if (status && !status.success) return { message: "Please choose a valid status." };

  const parsed = parseTaskForm(formData);
  // With "Save changes and switch status", say clearly that neither part was saved.
  const notSaved = status ? "Your changes were not saved and the status was not changed. Please fix the highlighted fields." : undefined;
  if (!parsed.success) return { errors: parsed.errors, values: parsed.values, message: notSaved };

  try {
    const current = await prisma.task.findFirst({ where: { id: id.data, userId: user.id } });
    if (!current) return { message: "This task was not found." };
    if (!(await ownsCategory(user.id, parsed.data.categoryId))) {
      return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values, message: notSaved };
    }
    // Repeating tasks are anchored to their planned date, so it cannot be removed.
    if (current.seriesId && parsed.data.plannedDate === null) {
      return { errors: { plannedDate: "A repeating task needs a planned date." }, values: parsed.values, message: notSaved };
    }

    const deadline = applyDeadlineChange(
      {
        deadlineDate: dateFromDb(current.deadlineDate),
        originalDeadlineDate: dateFromDb(current.originalDeadlineDate),
        rescheduleCount: current.rescheduleCount,
      },
      parsed.data.deadlineDate,
    );
    const fields = {
      ...taskColumns(parsed.data),
      originalDeadlineDate: dateToDb(deadline.originalDeadlineDate),
      rescheduleCount: deadline.rescheduleCount,
    };
    if (current.seriesId && status?.data === "COMPLETED") {
      // Completing a repeating task also creates its next instance: the edits, the
      // completion and the new instance are saved together or not at all.
      await prisma.$transaction(async (tx) => {
        await tx.task.update({ where: { id: current.id, userId: user.id }, data: fields });
        await completeTaskInTx(tx, { userId: user.id }, current.id);
      });
    } else {
      await prisma.task.update({
        where: { id: current.id, userId: user.id },
        data: { ...fields, ...(status && { status: status.data, completedAt: completedAtFor(current, status.data, new Date()) }) },
      });
    }
  } catch (error) {
    if (isMissingCategory(error)) return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values, message: notSaved };
    return { message: SAVE_FAILED };
  }
  if (status) {
    refresh();
    return {};
  }
  redirect(await returnPath(user.id, formData.get("returnCategory")));
}

export async function setTaskStatus(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = taskIdSchema.safeParse(formData.get("id"));
  const status = taskStatusSchema.safeParse(formData.get("status"));
  if (!id.success || !status.success) return;

  const current = await prisma.task.findFirst({
    where: { id: id.data, userId: user.id },
    select: { id: true, status: true, completedAt: true, seriesId: true },
  });
  if (!current) return;

  if (current.seriesId && status.data === "COMPLETED") {
    // A repeating task also creates its next instance; the recurrence service does
    // both in one transaction and is safe to call twice.
    const result = await completeTask({ userId: user.id }, current.id);
    if (!result.ok && result.error.code !== "NOT_FOUND") throw new Error(result.error.message);
  } else {
    // Everything else, including "undo complete" of a repeating task, is a plain status change.
    await prisma.task.update({
      where: { id: current.id, userId: user.id },
      data: { status: status.data, completedAt: completedAtFor(current, status.data, new Date()) },
    });
  }
  refresh();
}
