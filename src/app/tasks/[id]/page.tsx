import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { CategoryChip } from "@/components/category-chip";
import { ImportanceBadge, StatusBadge, TimingBadges } from "@/components/task-badges";
import { TaskEditor } from "@/components/task-editor";
import { formatInstant, formatLocalDate, nowInTimeZone } from "@/lib/local-time";
import { getMyCategories, getMyCategory } from "@/lib/categories";
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
  const categories = (await getMyCategories()).map(({ id, name, color }) => ({ id, name, color }));

  // "?category=<id>" means the task was opened from that category's filtered
  // list. It is only used if it is one of the user's own categories; anything
  // else (deleted, unknown, someone else's, not an id) is ignored.
  const requested = (await searchParams).category;
  const returnCategory = typeof requested === "string" && requested !== "" ? await getMyCategory(requested) : null;
  const backHref = returnCategory ? `/?category=${returnCategory.id}` : "/";

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <Link href={backHref} className="inline-flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-back-link>
          <ArrowLeft className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{returnCategory ? `Tasks in “${returnCategory.name}”` : "All tasks"}</span>
        </Link>

        <h1 className="mt-3 text-xl font-semibold break-words">{task.title}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusBadge status={task.status} />
          <ImportanceBadge importance={task.importance} />
          <TimingBadges task={task} now={now} />
          {task.category && <CategoryChip category={task.category} />}
        </div>

        <TaskEditor
          task={task}
          categories={categories}
          returnCategoryId={returnCategory?.id}
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
