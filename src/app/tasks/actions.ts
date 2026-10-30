"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { dateFromDb, dateToDb, timeFromDb, timeToDb } from "@/lib/local-time";
import { buildSeriesPatch, issueFieldErrors, parseRepeatForm, recurrenceMessage, type ParsedRepeat, type RepeatField, type RepeatFormValues } from "@/lib/recurrence/form";
import {
  completeTask,
  completeTaskInTx,
  convertInTx,
  createRecurringTask,
  disableRecurrenceInTx,
  runInTransaction,
  updateTaskAndSeriesInTx,
} from "@/lib/recurrence/service";
import type { RecurrenceError, Result } from "@/lib/recurrence/types";
import { returnHref } from "@/lib/return-path";
import { returnTargetFromForm } from "@/lib/return-target";
import { requireUser } from "@/lib/session";
import { applyDeadlineChange, completedAtFor } from "@/lib/task-rules";
import { ACTIVE_TASK } from "@/lib/task-state";
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
  errors?: Partial<Record<TaskFormField | RepeatField, string>>;
  message?: string;
  values?: TaskFormValues;
  // The Repeat section as the user left it, so an error does not lose it.
  repeat?: RepeatFormValues;
};

function taskColumns(input: TaskInput) {
  return {
    categoryId: input.categoryId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    plannedDate: dateToDb(input.plannedDate),
    plannedTime: timeToDb(input.plannedTime),
    deadlineDate: dateToDb(input.deadlineDate),
    deadlineTime: timeToDb(input.deadlineTime),
    estimatedMinutes: input.estimatedMinutes,
  };
}

const SAVE_FAILED = "Sorry, the task could not be saved. Please try again.";
const CATEGORY_INVALID = "Please choose one of your categories.";
const PLANNED_DATE_REQUIRED = "A repeating task needs a planned date.";
const STALE_PAGE = "This page is out of date. Reload it and try again. Nothing was saved.";

// A category id sent by the browser is only accepted if the category belongs to
// the logged-in user. Someone else's category and an unknown id look exactly
// the same: both are simply "not one of your categories".
async function ownsCategory(userId: string, categoryId: string | null) {
  if (categoryId === null) return true;
  return (await prisma.category.count({ where: { id: categoryId, userId } })) === 1;
}

// Where to go after saving. The browser only sends short values (dashboard / a due filter / a category
// id), never a URL; the path is BUILT here from validated pieces, and a category id is kept only if it is
// one of the user's own categories. Anything else (an URL, junk, a deleted or someone else's category)
// goes to the plain Tasks list.
async function returnPath(userId: string, formData: FormData) {
  return returnHref(await returnTargetFromForm(userId, formData));
}

// The category was deleted between the check and the save.
const isMissingCategory = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2003";

// A typed failure of the recurrence service, shown on the form without losing input.
function failureState(error: RecurrenceError, values: TaskFormValues, repeat: RepeatFormValues, notSaved?: string): TaskFormState {
  const errors = issueFieldErrors(error.issues) as NonNullable<TaskFormState["errors"]>;
  if (error.message === CATEGORY_INVALID) errors.categoryId = CATEGORY_INVALID;
  if (Object.keys(errors).length > 0) return { errors, values, repeat, message: notSaved };
  return { message: [recurrenceMessage(error), notSaved].filter(Boolean).join(" "), values, repeat };
}

const repeatChoiceOf = (repeat: ParsedRepeat) => (repeat.choice.type === "NEVER" ? null : { type: repeat.choice.type, weekdays: repeat.choice.weekdays, endDate: repeat.choice.endDate });

export async function createTask(_state: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const user = await requireUser();
  const parsed = parseTaskForm(formData);
  const repeat = parseRepeatForm(formData);
  const errors = { ...(parsed.success ? {} : parsed.errors), ...repeat.errors };
  if (!parsed.success || Object.keys(repeat.errors).length > 0) return { errors, values: parsed.values, repeat: repeat.values };

  const choice = repeatChoiceOf(repeat);
  if (choice && parsed.data.plannedDate === null) {
    return { errors: { plannedDate: PLANNED_DATE_REQUIRED }, values: parsed.values, repeat: repeat.values };
  }

  try {
    if (!(await ownsCategory(user.id, parsed.data.categoryId))) {
      return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values, repeat: repeat.values };
    }
    if (choice) {
      // The task and its repeating series are created together, or not at all.
      const result = await createRecurringTask({ userId: user.id }, parsed.data, choice);
      if (!result.ok) return failureState(result.error, parsed.values, repeat.values);
    } else {
      await prisma.task.create({
        data: {
          ...taskColumns(parsed.data),
          userId: user.id,
          originalDeadlineDate: dateToDb(parsed.data.deadlineDate),
        },
      });
    }
  } catch (error) {
    if (isMissingCategory(error)) return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values, repeat: repeat.values };
    return { message: SAVE_FAILED, values: parsed.values, repeat: repeat.values };
  }
  redirect(await returnPath(user.id, formData));
}

// Saves the edit form. When the form also sends a "status" (the "Save changes
// and switch status" choice), the edits and the new status are saved together
// in one update and the user stays on the task page; if the edits are invalid,
// nothing is saved and the status stays as it was.
//
// Repeating tasks: the Repeat section and the edit scope decide what is saved.
// - "Only this task" (the default) saves this task's fields and nothing else: the
//   series and every other task stay exactly as they are.
// - "This and future tasks" saves the changed fields to the series template (all
//   unfinished tasks of the series), applies repeat-rule changes, and saves this
//   task's own dates, all in ONE transaction, and only if the series has not
//   changed since the form was opened.
// - "Never" (in the future scope) stops the series and keeps this task as an ordinary one.
// - On an ordinary task, choosing a repeat makes it repeat (same task, same id).
export async function updateTask(_state: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const user = await requireUser();
  const id = taskIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { message: "This task was not found." };

  const requestedStatus = formData.get("status");
  const status = requestedStatus === null ? null : taskStatusSchema.safeParse(requestedStatus);
  if (status && !status.success) return { message: "Please choose a valid status." };

  const parsed = parseTaskForm(formData);
  const repeat = parseRepeatForm(formData);
  // With "Save changes and switch status", say clearly that neither part was saved.
  const notSaved = status ? "Your changes were not saved and the status was not changed. Please fix the highlighted fields." : undefined;

  try {
    const current = await prisma.task.findFirst({ where: { id: id.data, userId: user.id, ...ACTIVE_TASK } });
    if (!current) return { message: "This task was not found." };

    const isSeries = current.seriesId !== null;
    // Repeat settings apply to ordinary tasks and to the "this and future" scope.
    const repeatApplies = !isSeries || (repeat.scope === "SERIES" && current.status !== "COMPLETED");
    const repeatErrors = repeatApplies ? repeat.errors : {};
    if (!parsed.success || Object.keys(repeatErrors).length > 0) {
      return { errors: { ...(parsed.success ? {} : parsed.errors), ...repeatErrors }, values: parsed.values, repeat: repeat.values, message: notSaved };
    }
    const data = parsed.data;
    const choice = repeatApplies ? repeatChoiceOf(repeat) : null;
    const stopsRepeating = isSeries && repeatApplies && choice === null;

    if (!(await ownsCategory(user.id, data.categoryId))) {
      return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values, repeat: repeat.values, message: notSaved };
    }
    // Repeating tasks are anchored to their planned date, so it cannot be removed.
    if ((isSeries && !stopsRepeating || (!isSeries && choice)) && data.plannedDate === null) {
      return { errors: { plannedDate: PLANNED_DATE_REQUIRED }, values: parsed.values, repeat: repeat.values, message: notSaved };
    }

    const deadline = applyDeadlineChange(
      {
        deadlineDate: dateFromDb(current.deadlineDate),
        originalDeadlineDate: dateFromDb(current.originalDeadlineDate),
        rescheduleCount: current.rescheduleCount,
      },
      data.deadlineDate,
    );
    const fields = {
      ...taskColumns(data),
      originalDeadlineDate: dateToDb(deadline.originalDeadlineDate),
      rescheduleCount: deadline.rescheduleCount,
    };
    const statusData = status ? { status: status.data, completedAt: completedAtFor(current, status.data, new Date()) } : {};
    const ctx = { userId: user.id };
    const version = repeat.seriesVersion;

    let result: Result<unknown> | null = null;
    if (!isSeries && choice) {
      // An ordinary task starts repeating: its edits and the new series are saved together.
      result = await runInTransaction(async (tx) => {
        await tx.task.update({ where: { id: current.id, userId: user.id }, data: { ...fields, ...(status?.data === "COMPLETED" ? {} : statusData) } });
        await convertInTx(tx, ctx, current.id, choice);
        if (status?.data === "COMPLETED") await completeTaskInTx(tx, ctx, current.id); // also creates its next task
      });
    } else if (stopsRepeating) {
      if (version === null) return { message: STALE_PAGE, values: parsed.values, repeat: repeat.values };
      result = await runInTransaction(async (tx) => {
        await tx.task.update({ where: { id: current.id, userId: user.id }, data: { ...fields, ...statusData } });
        await disableRecurrenceInTx(tx, ctx, current.id, version);
      });
    } else if (isSeries && choice) {
      if (version === null) return { message: STALE_PAGE, values: parsed.values, repeat: repeat.values };
      const series = await prisma.recurringSeries.findFirst({ where: { id: current.seriesId!, userId: user.id } });
      if (!series) return { message: "This task was not found." };
      const patch = buildSeriesPatch(
        { ...data, plannedDate: data.plannedDate! },
        {
          title: current.title, description: current.description, priority: current.priority, estimatedMinutes: current.estimatedMinutes, categoryId: current.categoryId,
          plannedDate: dateFromDb(current.plannedDate), plannedTime: timeFromDb(current.plannedTime), deadlineDate: dateFromDb(current.deadlineDate), deadlineTime: timeFromDb(current.deadlineTime),
        },
        { type: series.type, weekdays: series.weekdays, endDate: dateFromDb(series.endDate) },
        choice,
      );
      result = await runInTransaction(async (tx) => {
        await updateTaskAndSeriesInTx(tx, ctx, current.id, version, patch, {
          plannedDate: data.plannedDate!, plannedTime: data.plannedTime, deadlineDate: data.deadlineDate, deadlineTime: data.deadlineTime,
        });
        if (status?.data === "COMPLETED") await completeTaskInTx(tx, ctx, current.id);
        else if (status) await tx.task.update({ where: { id: current.id, userId: user.id }, data: statusData });
      });
    } else if (isSeries && status?.data === "COMPLETED") {
      // "Only this task", completing: the edits, the completion and the next task are saved together.
      result = await runInTransaction(async (tx) => {
        await tx.task.update({ where: { id: current.id, userId: user.id }, data: fields });
        await completeTaskInTx(tx, ctx, current.id);
      });
    } else {
      // An ordinary task, or "Only this task": just this one row.
      await prisma.task.update({ where: { id: current.id, userId: user.id }, data: { ...fields, ...statusData } });
    }
    if (result && !result.ok) return failureState(result.error, parsed.values, repeat.values, notSaved);
  } catch (error) {
    if (isMissingCategory(error)) return { errors: { categoryId: CATEGORY_INVALID }, values: parsed.values, repeat: repeat.values, message: notSaved };
    return { message: SAVE_FAILED, values: parsed.values, repeat: repeat.values };
  }
  if (status) {
    refresh();
    return {};
  }
  redirect(await returnPath(user.id, formData));
}

export async function setTaskStatus(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = taskIdSchema.safeParse(formData.get("id"));
  const status = taskStatusSchema.safeParse(formData.get("status"));
  if (!id.success || !status.success) return;

  const current = await prisma.task.findFirst({
    where: { id: id.data, userId: user.id, ...ACTIVE_TASK },
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
