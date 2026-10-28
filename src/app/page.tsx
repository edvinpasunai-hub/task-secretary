import { ListTodo } from "lucide-react";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import { TaskCard } from "@/components/task-card";
import { nowInTimeZone } from "@/lib/local-time";
import { requireUser } from "@/lib/session";
import { getMyTasks } from "@/lib/tasks";

// Temporary Stage 4 task list. Stage 5 replaces it with the dashboard and its categories.
export default function Home() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading your tasks…</p>}>
      <TaskList />
    </Suspense>
  );
}

async function TaskList() {
  const user = await requireUser();
  const tasks = await getMyTasks();
  const now = nowInTimeZone(user.timeZone);
  const active = tasks.filter((task) => task.status !== "COMPLETED");
  const completed = tasks.filter((task) => task.status === "COMPLETED");

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {tasks.length === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <SecretaryAvatar />
            <h1 className="mt-4 text-xl font-semibold">No tasks yet, Boss!</h1>
            <p className="mt-1 text-muted-foreground">Use “Add task” to give me your first assignment.</p>
          </div>
        ) : (
          <>
            <section aria-labelledby="active-heading">
              <h1 id="active-heading" className="flex items-center gap-2 text-lg font-semibold">
                <ListTodo className="size-5 text-primary" aria-hidden />
                Your tasks <span className="font-normal text-muted-foreground">({active.length})</span>
              </h1>
              {active.length === 0 ? (
                <p className="mt-3 text-muted-foreground">Everything is done. Excellent work, Boss!</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {active.map((task) => (
                    <TaskCard key={task.id} task={task} now={now} timeZone={user.timeZone} />
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
                    <TaskCard key={task.id} task={task} now={now} timeZone={user.timeZone} />
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
