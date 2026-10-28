import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { ImportanceBadge, StatusBadge, TimingBadges } from "@/components/task-badges";
import { TaskEditor } from "@/components/task-editor";
import { formatInstant, formatLocalDate, nowInTimeZone } from "@/lib/local-time";
import { requireUser } from "@/lib/session";
import { getMyTask } from "@/lib/tasks";

export const metadata: Metadata = {
  title: "Task · Task Secretary",
};

export default function TaskPage({ params }: PageProps<"/tasks/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading task…</p>}>
      <TaskDetails params={params} />
    </Suspense>
  );
}

async function TaskDetails({ params }: Pick<PageProps<"/tasks/[id]">, "params">) {
  const user = await requireUser();
  const { id } = await params;
  // Returns null for unknown ids and for tasks owned by someone else.
  const task = await getMyTask(id);
  if (!task) notFound();

  const now = nowInTimeZone(user.timeZone);

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          All tasks
        </Link>

        <h1 className="mt-3 text-xl font-semibold break-words">{task.title}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusBadge status={task.status} />
          <ImportanceBadge importance={task.importance} />
          <TimingBadges task={task} now={now} />
        </div>

        <TaskEditor
          task={task}
          details={
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
          }
        />
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
