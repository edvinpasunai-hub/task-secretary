import { Plus } from "lucide-react";
import Link from "next/link";

import { LogoutButton } from "@/components/logout-button";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import { buttonVariants } from "@/components/ui/button";
import type { CurrentUser } from "@/lib/session";

// Temporary Stage 4 header. Stage 5 replaces it with the dashboard navigation.
export function AppHeader({ user }: { user: CurrentUser }) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex min-w-0 items-center gap-2 font-semibold">
          <SecretaryAvatar className="size-9 [&_svg]:size-5" />
          <span className="truncate">Task Secretary</span>
        </Link>
        <span className="ml-auto hidden truncate text-sm text-muted-foreground sm:inline">{user.email}</span>
        <Link href="/tasks/new" className={buttonVariants({ size: "lg", className: "ml-auto sm:ml-0" })}>
          <Plus aria-hidden />
          Add task
        </Link>
        <LogoutButton compact />
      </div>
    </header>
  );
}
