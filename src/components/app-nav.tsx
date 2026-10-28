"use client";

import { ListTodo, Tags } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Tasks", Icon: ListTodo, match: (path: string) => path === "/" || path.startsWith("/tasks") },
  { href: "/categories", label: "Categories", Icon: Tags, match: (path: string) => path.startsWith("/categories") },
] as const;

// Temporary Stage 4 navigation. Stage 5 replaces it with the dashboard sidebar.
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="mx-auto flex max-w-3xl gap-1 px-4 pb-2">
      {LINKS.map(({ href, label, Icon, match }) => {
        const current = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
              current && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
