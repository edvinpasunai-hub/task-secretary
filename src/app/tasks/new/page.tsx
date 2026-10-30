import type { Metadata } from "next";
import { Suspense } from "react";

import { createTask } from "@/app/tasks/actions";
import { AppHeader } from "@/components/app-header";
import { TaskForm } from "@/components/task-form";
import { getMyCategories } from "@/lib/categories";
import { parseReturnFromSearch } from "@/lib/return-path";
import { resolveReturn } from "@/lib/return-target";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Add task · Task Secretary",
};

export default function NewTaskPage({ searchParams }: PageProps<"/tasks/new">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading…</p>}>
      <NewTask searchParams={searchParams} />
    </Suspense>
  );
}

async function NewTask({ searchParams }: Pick<PageProps<"/tasks/new">, "searchParams">) {
  const user = await requireUser();
  // "?from=dashboard" (the dashboard's Add task button): saving or cancelling returns there.
  const { target: returnTarget } = await resolveReturn(user.id, parseReturnFromSearch(await searchParams));
  const categories = (await getMyCategories()).map(({ id, name, color }) => ({ id, name, color }));
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <h1 className="mb-6 text-xl font-semibold">Add a task</h1>
        <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          <TaskForm action={createTask} submitLabel="Add task" categories={categories} returnTarget={returnTarget} />
        </div>
      </main>
    </>
  );
}
