"use client";

import { LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { useLayoutEffect, useState, useTransition } from "react";

import { deleteForeverAction, emptyTrashAction, restoreFromTrashAction, type TrashActionResult } from "@/app/tasks/trash-actions";
import { CategoryChip } from "@/components/category-chip";
import { StatusBadge } from "@/components/task-badges";
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
import { formatInstant } from "@/lib/local-time";
import type { TrashItem } from "@/lib/trash/queries";

type Confirm = { kind: "one"; item: TrashItem } | { kind: "all" } | null;

// The Trash page's list: Restore, "Delete permanently" (confirmed) and "Empty Trash" (confirmed).
// Each task shows when it will be deleted for good.
export function TrashList({ items, timeZone }: { items: TrashItem[]; timeZone: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TrashActionResult | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  // Never reappear with the dialog open after Next.js hides and restores the page.
  useLayoutEffect(() => () => setConfirm(null), []);

  function run(action: () => Promise<TrashActionResult>, afterDone?: () => void) {
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      afterDone?.();
    });
  }

  return (
    <div data-trash-list>
      {items.length > 0 && (
        <div className="mb-3 flex justify-end">
          <Button type="button" variant="outline" size="lg" className="h-9 text-destructive hover:text-destructive" disabled={pending} onClick={() => setConfirm({ kind: "all" })}>
            <Trash2 aria-hidden />
            Empty Trash
          </Button>
        </div>
      )}

      {result && (
        <p role={result.ok ? "status" : "alert"} className={`mb-3 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-muted" : "bg-destructive/10 text-destructive"}`} data-trash-result>
          {result.message}
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground" data-trash-empty>
          Trash is empty.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs" data-trash-item={item.id}>
              <div className="min-w-0">
                <p className="font-medium break-words">{item.title}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <StatusBadge status={item.status} />
                  {item.repeats && <span className="text-xs text-muted-foreground">Repeating task</span>}
                  {item.category && <CategoryChip category={item.category} />}
                </div>
                <p className="mt-2 text-sm text-muted-foreground" data-trash-retention>
                  Deleted {formatInstant(item.deletedAt, timeZone)} · deleted permanently on {formatInstant(item.purgeAt, timeZone)} ·{" "}
                  <span className="text-foreground">{item.daysLeft === 1 ? "1 day left" : `${item.daysLeft} days left`}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="lg" className="h-9" disabled={pending} onClick={() => run(() => restoreFromTrashAction({ taskId: item.id }))}>
                  <RotateCcw aria-hidden />
                  Restore
                </Button>
                <Button type="button" variant="outline" size="lg" className="h-9 text-destructive hover:text-destructive" disabled={pending} onClick={() => setConfirm({ kind: "one", item })}>
                  <Trash2 aria-hidden />
                  Delete permanently
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !pending && setConfirm(null)}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "all" ? "Empty Trash?" : "Delete this task permanently?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "all"
                ? "Every task in Trash is deleted for good, with its reminders. This cannot be undone."
                : confirm?.kind === "one"
                  ? `“${confirm.item.title}” is deleted for good, with its reminders. This cannot be undone.`
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="lg" className="h-10" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              size="lg"
              className="h-10"
              disabled={pending}
              data-confirm-delete
              onClick={() => {
                const current = confirm;
                if (!current) return;
                run(
                  () => (current.kind === "all" ? emptyTrashAction() : deleteForeverAction({ taskId: current.item.id })),
                  () => setConfirm(null),
                );
              }}
            >
              {pending && <LoaderCircle className="animate-spin" aria-hidden />}
              {confirm?.kind === "all" ? "Empty Trash" : "Delete permanently"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
