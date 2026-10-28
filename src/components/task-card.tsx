import { Check, RotateCcw } from "lucide-react";
import Link from "next/link";

import { SubmitButton } from "@/components/submit-button";
import { ImportanceBadge, StatusBadge, TimingBadges } from "@/components/task-badges";
import { setTaskStatus } from "@/app/tasks/actions";
import { formatInstant, formatLocalDateTime, type LocalNow } from "@/lib/local-time";
import { formatDuration } from "@/lib/task-rules";
import type { TaskView } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export function TaskCard({ task, now, timeZone }: { task: TaskView; now: LocalNow; timeZone: string }) {
  const completed = task.status === "COMPLETED";

  return (
    <li
      className={cn(
        "flex gap-3 rounded-xl border bg-card p-4 shadow-xs",
        task.importance === "HIGH" && !completed && "border-l-4 border-l-primary",
        completed && "bg-card/60",
      )}
    >
      <form action={setTaskStatus} className="pt-0.5">
        <input type="hidden" name="id" value={task.id} />
        <input type="hidden" name="status" value={completed ? "TODO" : "COMPLETED"} />
        <SubmitButton
          variant="outline"
          size="icon-lg"
          className={cn("rounded-full", completed && "bg-primary text-primary-foreground hover:bg-primary/80")}
          aria-label={completed ? `Reopen "${task.title}"` : `Mark "${task.title}" as completed`}
          title={completed ? "Reopen" : "Mark as completed"}
        >
          {completed ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
        </SubmitButton>
      </form>

      <div className="min-w-0 flex-1">
        <Link
          href={`/tasks/${task.id}`}
          className={cn("font-medium break-words hover:underline", completed && "text-muted-foreground line-through")}
        >
          {task.title}
        </Link>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusBadge status={task.status} />
          <ImportanceBadge importance={task.importance} />
          <TimingBadges task={task} now={now} />
        </div>

        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {task.plannedDate && (
            <div>
              <dt className="inline">Planned: </dt>
              <dd className="inline text-foreground">{formatLocalDateTime(task.plannedDate, task.plannedTime)}</dd>
            </div>
          )}
          {task.deadlineDate && (
            <div>
              <dt className="inline">Deadline: </dt>
              <dd className="inline text-foreground">{formatLocalDateTime(task.deadlineDate, task.deadlineTime)}</dd>
            </div>
          )}
          {task.estimatedMinutes !== null && (
            <div>
              <dt className="inline">Estimate: </dt>
              <dd className="inline text-foreground">{formatDuration(task.estimatedMinutes)}</dd>
            </div>
          )}
          {completed && task.completedAt && (
            <div>
              <dt className="inline">Completed: </dt>
              <dd className="inline text-foreground">{formatInstant(task.completedAt, timeZone)}</dd>
            </div>
          )}
        </dl>
      </div>
    </li>
  );
}
