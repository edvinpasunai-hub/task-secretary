import { AlertTriangle, CalendarClock, CheckCircle2, CircleDashed, Clock, Flag, PauseCircle, PlayCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LocalNow } from "@/lib/local-time";
import {
  IMPORTANCE_LABELS,
  isOverdue,
  isPlannedAfterDeadline,
  isPlannedTimeMissed,
  STATUS_LABELS,
  type TaskTiming,
} from "@/lib/task-rules";
import type { TaskView } from "@/lib/tasks";

// Every badge combines an icon and text, so meaning never depends on colour alone.

export const STATUS_ICONS = {
  TODO: CircleDashed,
  IN_PROGRESS: PlayCircle,
  POSTPONED: PauseCircle,
  COMPLETED: CheckCircle2,
} as const;

// One colour per status, used by the status badges and the status buttons.
// Dark-on-light (and light-on-dark in dark mode) keeps the text contrast above 4.5:1.
export const STATUS_COLORS = {
  TODO: "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
  IN_PROGRESS: "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
  POSTPONED: "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
  COMPLETED: "border-green-200 bg-green-100 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
} as const;

const warning = "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";

export function ImportanceBadge({ importance }: { importance: TaskView["importance"] }) {
  if (importance === "HIGH") {
    return (
      <Badge className="bg-primary/10 text-primary">
        <Flag aria-hidden />
        High importance
      </Badge>
    );
  }
  return <Badge variant="outline">{IMPORTANCE_LABELS[importance]} importance</Badge>;
}

export function StatusBadge({ status }: { status: TaskView["status"] }) {
  const Icon = STATUS_ICONS[status];
  return (
    <Badge variant="outline" className={STATUS_COLORS[status]} data-status={status}>
      <Icon aria-hidden />
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function TimingBadges({ task, now }: { task: TaskTiming; now: LocalNow }) {
  return (
    <>
      {isOverdue(task, now) && (
        <Badge variant="destructive">
          <AlertTriangle aria-hidden />
          Overdue
        </Badge>
      )}
      {isPlannedTimeMissed(task, now) && (
        <Badge className={warning}>
          <Clock aria-hidden />
          Planned time passed
        </Badge>
      )}
      {task.status !== "COMPLETED" && isPlannedAfterDeadline(task) && (
        <Badge className={warning}>
          <CalendarClock aria-hidden />
          Planned after deadline
        </Badge>
      )}
    </>
  );
}
