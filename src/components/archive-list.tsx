"use client";

import { ArchiveRestore } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { unarchiveTaskAction, type TrashActionResult } from "@/app/tasks/trash-actions";
import { CategoryChip } from "@/components/category-chip";
import { Button } from "@/components/ui/button";
import { formatInstant } from "@/lib/local-time";
import type { TaskView } from "@/lib/tasks";

// The Archive page's list: finished tasks, view-only, with Restore.
export function ArchiveList({ tasks, timeZone }: { tasks: TaskView[]; timeZone: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TrashActionResult | null>(null);

  function restore(taskId: string) {
    setResult(null);
    startTransition(async () => setResult(await unarchiveTaskAction({ taskId })));
  }

  return (
    <div data-archive-list>
      {result && (
        <p role={result.ok ? "status" : "alert"} className={`mb-3 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-muted" : "bg-destructive/10 text-destructive"}`}>
          {result.message}
        </p>
      )}
      {tasks.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground" data-archive-empty>
          No archived tasks. Finished tasks you archive appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => (
            <li key={task.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs" data-archive-item={task.id}>
              <div className="min-w-0">
                <Link href={`/tasks/${task.id}`} className="font-medium break-words hover:underline">
                  {task.title}
                </Link>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  {task.completedAt && <span>Completed {formatInstant(task.completedAt, timeZone)}</span>}
                  {task.archivedAt && <span>· Archived {formatInstant(task.archivedAt, timeZone)}</span>}
                  {task.category && <CategoryChip category={task.category} />}
                </div>
              </div>
              <div>
                <Button type="button" variant="outline" size="lg" className="h-9" disabled={pending} onClick={() => restore(task.id)}>
                  <ArchiveRestore aria-hidden />
                  Restore
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
