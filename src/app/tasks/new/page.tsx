import type { Metadata } from "next";
import { Suspense } from "react";

import { createTask } from "@/app/tasks/actions";
import { AppHeader } from "@/components/app-header";
import { TaskForm } from "@/components/task-form";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Add task · Task Secretary",
};

export default function NewTaskPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading…</p>}>
      <NewTask />
    </Suspense>
  );
}

async function NewTask() {
  const user = await requireUser();
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <h1 className="mb-6 text-xl font-semibold">Add a task</h1>
        <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          <TaskForm action={createTask} submitLabel="Add task" />
        </div>
      </main>
    </>
  );
}
