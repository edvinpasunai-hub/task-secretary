import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { CategoryChip } from "@/components/category-chip";
import { RepeatBadge } from "@/components/repeat-badge";
import { SeriesPanel } from "@/components/series-panel";
import { PriorityBadge, StatusBadge, TimingBadges } from "@/components/task-badges";
import { TaskEditor } from "@/components/task-editor";
import { TaskRemoval } from "@/components/task-removal";
import { formatInstant, formatLocalDate, formatLocalDateTime, nowInTimeZone } from "@/lib/local-time";
import { getSeries, getSeriesForecast } from "@/lib/recurrence/service";
import { getMyCategories } from "@/lib/categories";
import { DUE_LABELS } from "@/lib/dashboard/sections";
import { parseReturnFromSearch, returnHref } from "@/lib/return-path";
import { resolveReturn } from "@/lib/return-target";
import { requireUser } from "@/lib/session";
import { getMyTask } from "@/lib/tasks";

export const metadata: Metadata = {
  title: "Task · Task Secretary",
};

export default function TaskPage({ params, searchParams }: PageProps<"/tasks/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading task…</p>}>
      <TaskDetails params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function TaskDetails({ params, searchParams }: Pick<PageProps<"/tasks/[id]">, "params" | "searchParams">) {
  const user = await requireUser();
  const { id } = await params;
  // Returns null for unknown ids and for tasks owned by someone else.
  const task = await getMyTask(id);
  if (!task) notFound();

  const now = nowInTimeZone(user.timeZone);
  // The series (if this task repeats) and the next task that will be created.
  const series = task.seriesId ? await getSeries({ userId: user.id }, task.seriesId) : null;
  const nextOccurrence = series ? ((await getSeriesForecast({ userId: user.id }, series.id, { limit: 1 })) ?? [])[0] : undefined;
  const categories = (await getMyCategories()).map(({ id, name, color }) => ({ id, name, color }));

  // Where the task was opened from: "?from=dashboard", or the Tasks list with its filters
  // ("?category=<id>&due=<section>"). Only these few validated values are read, the link is built
  // here (never taken from the URL), and a category must be one of the user's own; anything else
  // falls back to the plain Tasks list.
  const { target: returnTarget, categoryName } = await resolveReturn(user.id, parseReturnFromSearch(await searchParams));
  const backHref = returnHref(returnTarget);
  const backLabel =
    returnTarget.from === "dashboard"
      ? "Dashboard"
      : returnTarget.category && categoryName
        ? `Tasks in “${categoryName}”`
        : returnTarget.due
          ? `${DUE_LABELS[returnTarget.due]} tasks`
          : "All tasks";

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <Link href={backHref} className="inline-flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-back-link>
          <ArrowLeft className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{backLabel}</span>
        </Link>

        <h1 className="mt-3 text-xl font-semibold break-words">{task.title}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          <TimingBadges task={task} now={now} />
          {task.repeat && <RepeatBadge state={task.repeat.state} />}
          {task.category && <CategoryChip category={task.category} />}
        </div>

        {task.archivedAt ? (
          <>
            <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-sm" data-archived-notice>
              This task is archived, so it is view-only. Restore it to change it.
            </p>
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border bg-card p-4 text-sm shadow-xs sm:grid-cols-2" data-archived-details>
              <Detail label="Description" value={task.description ?? "None"} />
              <Detail label="Planned" value={task.plannedDate ? formatLocalDateTime(task.plannedDate, task.plannedTime) : "None"} />
              <Detail label="Deadline" value={task.deadlineDate ? formatLocalDateTime(task.deadlineDate, task.deadlineTime) : "None"} />
              <Detail label="Completed" value={task.completedAt ? formatInstant(task.completedAt, user.timeZone) : "Not yet"} />
              <Detail label="Archived" value={formatInstant(task.archivedAt, user.timeZone)} />
              <Detail label="Created" value={formatInstant(task.createdAt, user.timeZone)} />
            </dl>
          </>
        ) : (
        <TaskEditor
          task={task}
          categories={categories}
          returnTarget={returnTarget}
          series={series}
          details={
            <>
            {series && <SeriesPanel series={series} next={nextOccurrence ? formatLocalDateTime(nextOccurrence.date, nextOccurrence.time) : null} />}
            <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border bg-card p-4 text-sm shadow-xs sm:grid-cols-2">
              <Detail label="Created" value={formatInstant(task.createdAt, user.timeZone)} />
              <Detail label="Last updated" value={formatInstant(task.updatedAt, user.timeZone)} />
              <Detail
                label="Completed"
                value={task.completedAt ? formatInstant(task.completedAt, user.timeZone) : "Not yet"}
              />
              <Detail
                label="Original deadline"
                value={task.originalDeadlineDate ? formatLocalDate(task.originalDeadlineDate) : "None"}
              />
              <Detail
                label="Rescheduled"
                value={`${task.rescheduleCount} ${task.rescheduleCount === 1 ? "time" : "times"}`}
              />
            </dl>
            </>
          }
        />
        )}
        <TaskRemoval taskId={task.id} completed={task.status === "COMPLETED"} archived={task.archivedAt !== null} series={series} returnHref={backHref} />
      </main>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 sm:block">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
