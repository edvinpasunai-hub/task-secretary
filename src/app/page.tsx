import { Suspense } from "react";

import { LogoutButton } from "@/components/logout-button";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/session";

// Temporary Stage 3 home page. Replaced by the briefing and dashboard in later stages.
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <SecretaryAvatar className="mx-auto mb-4" />
        <h1 className="text-2xl font-semibold tracking-tight">Task Secretary</h1>
        <Suspense fallback={<p className="mt-2 text-muted-foreground">Checking your login…</p>}>
          <Welcome />
        </Suspense>
      </div>
    </main>
  );
}

async function Welcome() {
  const user = await requireUser();
  // Every task query is limited to the logged-in user's own tasks.
  const taskCount = await prisma.task.count({ where: { userId: user.id } });

  return (
    <>
      <p className="mt-2 text-muted-foreground">
        Hello, Boss! You are logged in as <span className="font-medium text-foreground">{user.email}</span>.
      </p>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="task-count">
        You have {taskCount} {taskCount === 1 ? "task" : "tasks"}.
      </p>
      <div className="mt-6">
        <LogoutButton />
      </div>
    </>
  );
}
