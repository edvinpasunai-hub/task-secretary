"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { dateFromDb, dateToDb, timeToDb } from "@/lib/local-time";
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

export async function createTask(_state: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const user = await requireUser();
  const parsed = parseTaskForm(formData);
  if (!parsed.success) return { errors: parsed.errors, values: parsed.values };

  try {
    await prisma.task.create({
      data: {
        ...taskColumns(parsed.data),
        userId: user.id,
        originalDeadlineDate: dateToDb(parsed.data.deadlineDate),
      },
    });
  } catch {
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
  if (!parsed.success) {
    return {
      errors: parsed.errors,
      values: parsed.values,
      message: status
        ? "Your changes were not saved and the status was not changed. Please fix the highlighted fields."
        : undefined,
    };
  }

  try {
    const current = await prisma.task.findFirst({ where: { id: id.data, userId: user.id } });
    if (!current) return { message: "This task was not found." };

    const deadline = applyDeadlineChange(
      {
        deadlineDate: dateFromDb(current.deadlineDate),
        originalDeadlineDate: dateFromDb(current.originalDeadlineDate),
        rescheduleCount: current.rescheduleCount,
      },
      parsed.data.deadlineDate,
    );
    await prisma.task.update({
      where: { id: current.id, userId: user.id },
      data: {
        ...taskColumns(parsed.data),
        originalDeadlineDate: dateToDb(deadline.originalDeadlineDate),
        rescheduleCount: deadline.rescheduleCount,
        ...(status && { status: status.data, completedAt: completedAtFor(current, status.data, new Date()) }),
      },
    });
  } catch {
    return { message: SAVE_FAILED };
  }
  if (status) {
    refresh();
    return {};
  }
  redirect("/");
}

export async function setTaskStatus(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = taskIdSchema.safeParse(formData.get("id"));
  const status = taskStatusSchema.safeParse(formData.get("status"));
  if (!id.success || !status.success) return;

  const current = await prisma.task.findFirst({
    where: { id: id.data, userId: user.id },
    select: { id: true, status: true, completedAt: true },
  });
  if (!current) return;

  await prisma.task.update({
    where: { id: current.id, userId: user.id },
    data: { status: status.data, completedAt: completedAtFor(current, status.data, new Date()) },
  });
  refresh();
}
