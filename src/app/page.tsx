import { ListTodo, X } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { CategoryFilter } from "@/components/category-filter";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import { TaskCard } from "@/components/task-card";
import { buttonVariants } from "@/components/ui/button";
import { getMyCategories, getMyCategory } from "@/lib/categories";
import { nowInTimeZone } from "@/lib/local-time";
import { requireUser } from "@/lib/session";
import { getMyTasks } from "@/lib/tasks";

// Temporary Stage 4 task list. Stage 5 replaces it with the dashboard.
// "/?category=<id>" shows only the tasks of one of the user's categories.
export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading your tasks…</p>}>
      <TaskList searchParams={searchParams} />
    </Suspense>
  );
}

function ClearFilterLink() {
  return (
    <Link href="/" className={buttonVariants({ variant: "outline", size: "lg", className: "h-9" })}>
      <X aria-hidden />
      Clear filter
    </Link>
  );
}

async function TaskList({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const user = await requireUser();
  const requested = (await searchParams).category;
  // An empty value means "no filter"; anything else (including a repeated
  // parameter) is checked against the user's own categories.
  const categoryParam = typeof requested === "string" ? requested : "";
  const filtering = categoryParam !== "" || Array.isArray(requested);
  // null for a deleted, unknown, malformed or someone else's category: all look the same.
  const category = categoryParam !== "" ? await getMyCategory(categoryParam) : null;
  const tasks = filtering && !category ? [] : await getMyTasks(category?.id);
  const categories = (await getMyCategories()).map(({ id, name, color }) => ({ id, name, color }));
  const now = nowInTimeZone(user.timeZone);
  const active = tasks.filter((task) => task.status !== "COMPLETED");
  const completed = tasks.filter((task) => task.status === "COMPLETED");

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
            <CategoryFilter key={category?.id ?? (filtering ? "missing" : "all")} categories={categories} current={category?.id ?? ""} missing={filtering && !category} />
            {filtering && <ClearFilterLink />}
          </div>
        )}

        {filtering && !category ? (
          <div className="mt-10 flex flex-col items-center text-center" data-category-missing>
            <SecretaryAvatar />
            <h1 className="mt-4 text-xl font-semibold">Sorry, Boss, I couldn’t find that category.</h1>
            <p className="mt-1 text-muted-foreground">It may have been deleted. Clear the filter to see your tasks again.</p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <SecretaryAvatar />
            {category ? (
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
                {category ? "Tasks" : "Your tasks"} <span className="font-normal text-muted-foreground">({active.length})</span>
              </h1>
              {active.length === 0 ? (
                <p className="mt-3 text-muted-foreground">Everything is done. Excellent work, Boss!</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {active.map((task) => (
                    <TaskCard key={task.id} task={task} now={now} timeZone={user.timeZone} categoryFilterId={category?.id} />
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
                    <TaskCard key={task.id} task={task} now={now} timeZone={user.timeZone} categoryFilterId={category?.id} />
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
