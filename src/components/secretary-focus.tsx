import { Check, Plus, Target } from "lucide-react";
import Link from "next/link";

import { setTaskStatus } from "@/app/tasks/actions";
import { SubmitButton } from "@/components/submit-button";
import { PriorityBadge } from "@/components/task-badges";
import { buttonVariants } from "@/components/ui/button";
import type { FocusItem } from "@/lib/ranking/focus";
import { returnQuery } from "@/lib/return-path";

const FROM_DASHBOARD = returnQuery({ from: "dashboard", due: null, category: null });

// Secretary's Focus: the top-ranked tasks (at most five) as one compact list at the top of the dashboard.
// Everything shown is text (the priority and the reason are words, never only a colour) and no score is shown. The
// rows reuse the existing pieces: the task link keeps the "came from the dashboard" return (a short validated value, no
// task content in the URL), and the check button is the existing Complete action (setTaskStatus), which re-renders the
// dashboard, so a completed task leaves the list and the next one takes its place.
export function SecretaryFocus({ items }: { items: FocusItem[] }) {
  return (
    <section aria-labelledby="focus-heading" className="mt-5" data-focus>
      <h2 id="focus-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Target className="size-5 text-primary" aria-hidden />
        Secretary’s Focus
      </h2>
      <p className="text-sm text-muted-foreground" data-focus-subtitle>
        Recommended tasks to focus on next
      </p>

      {items.length === 0 ? (
        <div className="mt-3 flex flex-col items-start gap-3 rounded-xl border bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between" data-focus-empty>
          <p className="text-sm">You’re all caught up. No tasks need your attention right now.</p>
          <Link href="/tasks/new?from=dashboard" className={buttonVariants({ variant: "outline", size: "lg", className: "h-9 shrink-0" })} data-focus-add>
            <Plus aria-hidden />
            Add task
          </Link>
        </div>
      ) : (
        <ol className="mt-3 divide-y rounded-xl border bg-card shadow-xs" data-focus-list>
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 p-3" data-focus-item={item.id} data-focus-rank={item.rank}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary" data-focus-position>
                <span className="sr-only">Number </span>
                {item.rank}
              </span>

              <div className="min-w-0 flex-1">
                <Link href={`/tasks/${item.id}?${FROM_DASHBOARD}`} className="font-medium break-words hover:underline" data-focus-title>
                  {item.title}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <PriorityBadge priority={item.priority} />
                  <span className="text-muted-foreground" data-focus-due>
                    {item.dueLabel}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground" data-focus-reason>
                  {item.reason}
                </p>
              </div>

              <form action={setTaskStatus} className="shrink-0">
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="status" value="COMPLETED" />
                <SubmitButton variant="outline" size="icon-lg" className="rounded-full" aria-label={`Mark "${item.title}" as completed`} title="Mark as completed">
                  <Check aria-hidden />
                </SubmitButton>
              </form>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
