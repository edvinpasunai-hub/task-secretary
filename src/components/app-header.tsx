import Link from "next/link";
import { Suspense } from "react";

import { AddTaskLink } from "@/components/add-task-link";
import { AppNav } from "@/components/app-nav";
import { NotificationBell, NotificationBellFallback } from "@/components/notification-bell";
import { LogoutButton } from "@/components/logout-button";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import type { CurrentUser } from "@/lib/session";

export function AppHeader({ user }: { user: CurrentUser }) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex min-w-0 items-center gap-2 font-semibold">
          <SecretaryAvatar className="size-9 [&_svg]:size-5" />
          <span className="truncate">Task Secretary</span>
        </Link>
        <span className="ml-auto hidden truncate text-sm text-muted-foreground sm:inline">{user.email}</span>
        <AddTaskLink />
        <Suspense fallback={<NotificationBellFallback />}>
          <NotificationBell user={user} />
        </Suspense>
        <LogoutButton compact />
      </div>
      <AppNav />
    </header>
  );
}
