"use client";

import { LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { setTaskStatus, updateTask } from "@/app/tasks/actions";
import { STATUS_COLORS, STATUS_ICONS } from "@/components/task-badges";
import { TaskForm, type TaskFormHandle } from "@/components/task-form";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { TaskStatus } from "@/generated/prisma/enums";
import { STATUS_LABELS, TASK_STATUSES } from "@/lib/task-rules";
import type { TaskView } from "@/lib/tasks";
import type { TaskCategory } from "@/lib/category-rules";
import { cn } from "@/lib/utils";

// The task page's status buttons and edit form. Switching status is immediate,
// unless the form has unsaved changes: then the user chooses to save them,
// discard them, or keep editing.
export function TaskEditor({ task, details, categories, returnCategoryId }: { task: TaskView; details: ReactNode; categories: TaskCategory[]; returnCategoryId?: string }) {
  const form = useRef<TaskFormHandle>(null);
  const [pending, startTransition] = useTransition();
  const [requestedStatus, setRequestedStatus] = useState<TaskStatus | null>(null);

  // Never reappear with the dialog open after Next.js hides and restores the page.
  useLayoutEffect(() => () => setRequestedStatus(null), []);

  function switchStatus(status: TaskStatus) {
    const formData = new FormData();
    formData.set("id", task.id);
    formData.set("status", status);
    startTransition(() => setTaskStatus(formData));
  }

  function handleStatusClick(status: TaskStatus) {
    if (form.current?.hasUnsavedChanges()) setRequestedStatus(status);
    else switchStatus(status);
  }

  function saveAndSwitch() {
    if (!requestedStatus) return;
    const status = requestedStatus;
    setRequestedStatus(null);
    startTransition(() => form.current?.saveWithStatus(status));
  }

  function discardAndSwitch() {
    if (!requestedStatus) return;
    const status = requestedStatus;
    setRequestedStatus(null);
    form.current?.discardChanges();
    switchStatus(status);
  }

  return (
    <>
      <section aria-labelledby="status-heading" className="mt-6">
        <h2 id="status-heading" className="mb-2 flex items-center gap-2 text-sm font-medium">
          Status
          {pending && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Saving" />}
        </h2>
        <div role="group" aria-label="Task status" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TASK_STATUSES.map((status) => {
            const current = task.status === status;
            const Icon = STATUS_ICONS[status];
            return (
              <Button
                key={status}
                type="button"
                variant="outline"
                size="lg"
                className={cn("h-10 w-full", current && cn(STATUS_COLORS[status], "font-semibold disabled:opacity-100"))}
                aria-pressed={current}
                disabled={current || pending}
                onClick={() => handleStatusClick(status)}
              >
                <Icon aria-hidden />
                {STATUS_LABELS[status]}
              </Button>
            );
          })}
        </div>
      </section>

      {details}

      <section aria-labelledby="edit-heading" className="mt-6">
        <h2 id="edit-heading" className="mb-3 text-lg font-semibold">
          Edit task
        </h2>
        <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          <TaskForm ref={form} action={updateTask} task={task} submitLabel="Save changes" categories={categories} returnCategoryId={returnCategoryId} />
        </div>
      </section>

      <AlertDialog open={requestedStatus !== null} onOpenChange={(open) => !open && setRequestedStatus(null)}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>You have unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              Boss, you edited this task but did not save it yet. What should I do before switching the status to “
              {requestedStatus && STATUS_LABELS[requestedStatus]}”?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-col-reverse sm:justify-start">
            <AlertDialogCancel size="lg" className="h-10 w-full">
              Cancel and keep editing
            </AlertDialogCancel>
            <Button variant="outline" size="lg" className="h-10 w-full" onClick={discardAndSwitch}>
              Discard changes and switch status
            </Button>
            <Button size="lg" className="h-10 w-full" onClick={saveAndSwitch}>
              Save changes and switch status
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
