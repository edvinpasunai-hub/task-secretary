import { ListTodo, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { CategoryFilter } from "@/components/category-filter";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import { TaskCard } from "@/components/task-card";
import { buttonVariants } from "@/components/ui/button";
import { getMyCategories, getMyCategory } from "@/lib/categories";
import { DUE_LABELS, DUE_SECTIONS, isDueSection, type DueSection } from "@/lib/dashboard/sections";
import { nowInTimeZone } from "@/lib/local-time";
import { returnQuery } from "@/lib/return-path";
import { requireUser } from "@/lib/session";
import { getMyTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Tasks · Task Secretary",
};

// The Tasks list (all tasks, with filters). The dashboard is at "/".
// "/tasks?category=<id>" shows only the tasks of one of the user's categories;
// "/tasks?due=overdue|today|upcoming|later|none" shows the unfinished tasks of one dashboard section
// (the same rules, so "View all" matches the dashboard). The two filters combine.
export default function TasksPage({ searchParams }: PageProps<"/tasks">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading your tasks…</p>}>
      <TaskList searchParams={searchParams} />
    </Suspense>
  );
}

function ClearFilterLink() {
  return (
    <Link href="/tasks" className={buttonVariants({ variant: "outline", size: "lg", className: "h-9" })}>
      <X aria-hidden />
      Clear filter
    </Link>
  );
}

// A link that switches the due filter and keeps the category filter.
function dueHref(due: DueSection | null, categoryId: string | undefined) {
  const query = [categoryId && `category=${categoryId}`, due && `due=${due}`].filter(Boolean).join("&");
  return query ? `/tasks?${query}` : "/tasks";
}

async function TaskList({ searchParams }: Pick<PageProps<"/tasks">, "searchParams">) {
  const user = await requireUser();
  const params = await searchParams;
  const requested = params.category;
  // An empty value means "no filter"; anything else (including a repeated
  // parameter) is checked against the user's own categories.
  const categoryParam = typeof requested === "string" ? requested : "";
  const categoryFiltering = categoryParam !== "" || Array.isArray(requested);
  // null for a deleted, unknown, malformed or someone else's category: all look the same.
  const category = categoryParam !== "" ? await getMyCategory(categoryParam) : null;
  // An unknown or repeated due value is ignored (all tasks are shown).
  const due = typeof params.due === "string" && isDueSection(params.due) ? params.due : null;
  const filtering = categoryFiltering || due !== null;
  const tasks = categoryFiltering && !category ? [] : await getMyTasks(category?.id, due ?? undefined);
  const categories = (await getMyCategories()).map(({ id, name, color }) => ({ id, name, color }));
  const now = nowInTimeZone(user.timeZone);
  const active = tasks.filter((task) => task.status !== "COMPLETED");
  const completed = tasks.filter((task) => task.status === "COMPLETED");
  // Opening a task from here and coming back keeps these filters.
  const fromHere = returnQuery({ from: "tasks", due, category: category?.id ?? null });

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {/* Only worth showing when there is something to choose, or a filter to clear. */}
        {(categories.length > 0 || filtering) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-xs" role="region" aria-label="Task filter" data-filter-bar>
            <label htmlFor="category-filter" className="text-sm text-muted-foreground">
              Category:
            </label>
            <CategoryFilter key={category?.id ?? (categoryFiltering ? "missing" : "all")} categories={categories} current={category?.id ?? ""} missing={categoryFiltering && !category} due={due} />
            {filtering && <ClearFilterLink />}
          </div>
        )}

        <nav aria-label="Due date filter" className="mb-4 flex flex-wrap gap-1.5" data-due-filter>
          {([null, ...DUE_SECTIONS] as const).map((section) => {
            const current = section === due;
            return (
              <Link
                key={section ?? "all"}
                href={dueHref(section, category?.id)}
                aria-current={current ? "true" : undefined}
                data-due-link={section ?? "all"}
                className={cn(
                  "flex h-8 items-center rounded-full border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  current && "border-primary bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary",
                )}
              >
                {section ? DUE_LABELS[section] : "All"}
              </Link>
            );
          })}
        </nav>

        {categoryFiltering && !category ? (
          <div className="mt-10 flex flex-col items-center text-center" data-category-missing>
            <SecretaryAvatar />
            <h1 className="mt-4 text-xl font-semibold">Sorry, Boss, I couldn’t find that category.</h1>
            <p className="mt-1 text-muted-foreground">It may have been deleted. Clear the filter to see your tasks again.</p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center" data-empty-list>
            <SecretaryAvatar />
            {due ? (
              <>
                <h1 className="mt-4 text-xl font-semibold">Nothing in “{DUE_LABELS[due]}”, Boss!</h1>
                <p className="mt-1 text-muted-foreground">{category ? `No ${DUE_LABELS[due].toLowerCase()} tasks in “${category.name}”.` : "No unfinished tasks match this filter."}</p>
              </>
            ) : category ? (
              <>
                <h1 className="mt-4 text-xl font-semibold">No tasks in “{category.name}” yet, Boss!</h1>
                <p className="mt-1 text-muted-foreground">Assign this category to a task and it will show up here.</p>
              </>
            ) : (
              <>
                <h1 className="mt-4 text-xl font-semibold">No tasks yet, Boss!</h1>
                <p className="mt-1 text-muted-foreground">Use “Add task” to give me your first assignment.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <section aria-labelledby="active-heading">
              <h1 id="active-heading" className="flex items-center gap-2 text-lg font-semibold">
                <ListTodo className="size-5 text-primary" aria-hidden />
                {due ? `${DUE_LABELS[due]} tasks` : category ? "Tasks" : "Your tasks"} <span className="font-normal text-muted-foreground">({active.length})</span>
              </h1>
              {active.length === 0 ? (
                <p className="mt-3 text-muted-foreground">Everything is done. Excellent work, Boss!</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {active.map((task) => (
                    <TaskCard key={task.id} task={task} now={now} timeZone={user.timeZone} returnQuery={fromHere} />
                  ))}
                </ul>
              )}
            </section>

            {completed.length > 0 && (
              <section aria-labelledby="completed-heading" className="mt-8">
                <h2 id="completed-heading" className="text-lg font-semibold">
                  Completed <span className="font-normal text-muted-foreground">({completed.length})</span>
                </h2>
                <ul className="mt-3 flex flex-col gap-3">
                  {completed.map((task) => (
                    <TaskCard key={task.id} task={task} now={now} timeZone={user.timeZone} returnQuery={fromHere} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
