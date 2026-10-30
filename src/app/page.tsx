import { CheckCircle2, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { DayRolloverRefresh } from "@/components/day-rollover-refresh";
import { PostponeMenu } from "@/components/postpone-menu";
import { TaskCard } from "@/components/task-card";
import { buttonVariants } from "@/components/ui/button";
import { getMyDashboard, SECTION_LIMIT, type DashboardData } from "@/lib/dashboard/queries";
import { DUE_LABELS } from "@/lib/dashboard/sections";
import { formatLocalDate } from "@/lib/local-time";
import { returnQuery } from "@/lib/return-path";
import { requireUser } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Dashboard · Task Secretary",
};

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading your dashboard…</p>}>
      <Dashboard />
    </Suspense>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The whole sentence of the Daily Briefing (always shown, also when everything is zero).
function briefingText({ dueToday, overdue, completedToday }: DashboardData["briefing"]) {
  const parts = [
    `${plural(dueToday, "task")} due today`,
    overdue === 0 ? "nothing overdue" : `${overdue} overdue`,
    `${completedToday} completed today`,
  ];
  return `You have ${parts[0]}, ${parts[1]} and ${parts[2]}.`;
}

function Counter({ label, value, href, tone, id }: { label: string; value: number; href?: string; tone?: "alert"; id: string }) {
  const body = (
    <>
      <span className={cn("text-2xl font-semibold tabular-nums", tone === "alert" && value > 0 && "text-destructive")} data-counter-value={id}>
        {value}
      </span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </>
  );
  const className = "flex flex-col gap-0.5 rounded-xl border bg-card p-3 shadow-xs";
  return href ? (
    <Link href={href} className={cn(className, "hover:bg-muted/50")} data-counter={id}>
      {body}
    </Link>
  ) : (
    <div className={className} data-counter={id}>
      {body}
    </div>
  );
}

async function Dashboard() {
  const user = await requireUser();
  const data = await getMyDashboard();
  const { counts, sections, now } = data;
  const fromDashboard = returnQuery({ from: "dashboard", due: null, category: null });

  const Section = ({ id, title, hint, extra }: { id: "overdue" | "today" | "upcoming" | "none"; title: string; hint?: string; extra?: React.ReactNode }) => {
    const tasks = sections[id];
    const total = counts[id];
    return (
      <section aria-labelledby={`${id}-heading`} className="mt-8" data-section={id}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id={`${id}-heading`} className="text-lg font-semibold">
            {title} <span className="font-normal text-muted-foreground" data-section-count={id}>({total})</span>
          </h2>
          <div className="flex items-center gap-3 text-sm">
            {extra}
            {total > 0 && (
              <Link href={`/tasks?due=${id}`} className="text-primary hover:underline" data-view-all={id}>
                View all{total > SECTION_LIMIT ? ` (${total})` : ""}
              </Link>
            )}
          </div>
        </div>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
        {tasks.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground" data-section-empty={id}>
            {id === "overdue" ? "Nothing overdue. Well done, Boss!" : id === "today" ? "Nothing due today." : id === "upcoming" ? "Nothing due in the next 7 days." : "Every task has a due date."}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                now={now}
                timeZone={user.timeZone}
                returnQuery={fromDashboard}
                extraActions={task.deadlineDate ? <PostponeMenu taskId={task.id} title={task.title} deadlineDate={task.deadlineDate} today={data.today} /> : undefined}
              />
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <>
      <AppHeader user={user} />
      <DayRolloverRefresh date={data.today} timeZone={user.timeZone} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6" data-dashboard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold" data-greeting>
              {data.greeting}
            </h1>
            <p className="text-sm text-muted-foreground" data-today>
              {formatLocalDate(data.today)}
            </p>
          </div>
          <Link href="/tasks/new?from=dashboard" className={buttonVariants({ size: "lg", className: "h-10" })} data-dashboard-add>
            <Plus aria-hidden />
            Add task
          </Link>
        </div>

        <section aria-labelledby="briefing-heading" className="mt-5 rounded-xl border bg-card p-4 shadow-xs" data-briefing>
          <h2 id="briefing-heading" className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="size-4 text-primary" aria-hidden />
            Daily briefing
          </h2>
          <p className="mt-1" data-briefing-text>
            {briefingText(data.briefing)}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Counter id="today" label="Due today" value={counts.today} href="/tasks?due=today" />
            <Counter id="overdue" label="Overdue" value={counts.overdue} href="/tasks?due=overdue" tone="alert" />
            <Counter id="upcoming" label="Upcoming (7 days)" value={counts.upcoming} href="/tasks?due=upcoming" />
            <Counter id="completed" label="Completed today" value={data.briefing.completedToday} />
          </div>
        </section>

        {Section({ id: "overdue", title: DUE_LABELS.overdue })}
        {Section({ id: "today", title: DUE_LABELS.today })}
        {Section({
          id: "upcoming",
          title: DUE_LABELS.upcoming,
          hint: "The next 7 days, not counting today.",
          extra:
            counts.later > 0 ? (
              <Link href="/tasks?due=later" className="text-muted-foreground hover:text-foreground hover:underline" data-later-link>
                Later ({counts.later})
              </Link>
            ) : (
              <span className="text-muted-foreground" data-later-link>
                Later (0)
              </span>
            ),
        })}
        {Section({ id: "none", title: DUE_LABELS.none })}
      </main>
    </>
  );
}
