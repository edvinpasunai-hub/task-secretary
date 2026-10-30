"use client";

import { Archive, ArchiveRestore, LoaderCircle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useState, useTransition } from "react";

import {
  archiveTaskAction,
  moveSeriesToTrashAction,
  moveToTrashAction,
  unarchiveTaskAction,
  type TrashActionResult,
} from "@/app/tasks/trash-actions";
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
import type { SeriesView } from "@/lib/recurrence/types";
import { TRASH_DAYS } from "@/lib/trash/rules";
import { cn } from "@/lib/utils";

type Scope = "TASK" | "SERIES";

// The task page's "Archive" and "Move to Trash" controls (and "Restore" for an archived task).
// A repeating, unfinished task asks what the delete applies to:
// - Only this task: that occurrence is skipped and the series carries on;
// - This and future tasks: the series is stopped for good (explicit confirmation) and every
//   unfinished task of it goes to Trash. Finished tasks stay.
export function TaskRemoval({ taskId, completed, archived, series, returnHref }: { taskId: string; completed: boolean; archived: boolean; series: SeriesView | null; returnHref: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("TASK");
  const [result, setResult] = useState<TrashActionResult | null>(null);

  // Never reappear with the dialog open after Next.js hides and restores the page.
  useLayoutEffect(() => () => setOpen(false), []);

  const canChooseScope = series !== null && series.state !== "STOPPED" && !completed && !archived;
  const stopsSeries = canChooseScope && scope === "SERIES";

  function run(action: () => Promise<TrashActionResult>, afterOk?: () => void) {
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) afterOk?.();
    });
  }

  function confirmTrash() {
    run(
      () => (stopsSeries && series ? moveSeriesToTrashAction({ taskId, version: series.version }) : moveToTrashAction({ taskId })),
      () => {
        setOpen(false);
        router.push(returnHref); // built on the server from validated values: always a local path
      },
    );
  }

  return (
    <section aria-label="Archive and Trash" className="mt-6 flex flex-col gap-3" data-task-removal>
      <div className="flex flex-wrap gap-2">
        {archived ? (
          <Button type="button" variant="outline" size="lg" className="h-10" disabled={pending} onClick={() => run(() => unarchiveTaskAction({ taskId }))}>
            <ArchiveRestore aria-hidden />
            Restore to my tasks
          </Button>
        ) : (
          completed && (
            <Button type="button" variant="outline" size="lg" className="h-10" disabled={pending} onClick={() => run(() => archiveTaskAction({ taskId }))}>
              <Archive aria-hidden />
              Archive
            </Button>
          )
        )}
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10 text-destructive hover:text-destructive"
          disabled={pending}
          onClick={() => {
            setScope("TASK");
            setResult(null);
            setOpen(true);
          }}
        >
          <Trash2 aria-hidden />
          Move to Trash
        </Button>
      </div>

      {result && (
        <p role={result.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-muted" : "bg-destructive/10 text-destructive"}`} data-removal-result>
          {result.message}
        </p>
      )}

      <AlertDialog open={open} onOpenChange={(next) => !next && !pending && setOpen(false)}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Move this task to Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              You can restore it from Trash for {TRASH_DAYS} days. After that it is deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {canChooseScope && (
            <div role="radiogroup" aria-label="What should be moved to Trash?" className="flex flex-col gap-2" data-trash-scope>
              {(
                [
                  ["TASK", "Only this task", "This one is skipped. The series keeps repeating."],
                  ["SERIES", "This and future tasks", "Stops the series and moves this and every unfinished task of it to Trash. Finished tasks stay."],
                ] as const
              ).map(([value, label, help]) => (
                <label
                  key={value}
                  className="relative flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
                >
                  <input type="radio" name="trash-scope" value={value} checked={scope === value} onChange={() => setScope(value)} className="sr-only" />
                  {/* The selection mark is drawn here from the same state that decides what is submitted, so
                      what you see is always what is deleted (it does not depend on the browser's own radio). */}
                  <span
                    aria-hidden
                    data-scope-indicator={value}
                    data-selected={scope === value}
                    className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input", scope === value && "border-primary")}
                  >
                    {scope === value && <span className="size-2 rounded-full bg-primary" />}
                  </span>
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-muted-foreground">{help}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {stopsSeries && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-stop-warning>
              This permanently stops the repeating series. It cannot be resumed, even if you restore tasks from Trash. No new tasks will be created.
            </p>
          )}

          {result && !result.ok && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {result.message}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel size="lg" className="h-10" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button type="button" variant="destructive" size="lg" className="h-10" disabled={pending} onClick={confirmTrash} data-confirm-trash>
              {pending && <LoaderCircle className="animate-spin" aria-hidden />}
              {stopsSeries ? "Stop series and move to Trash" : "Move to Trash"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
