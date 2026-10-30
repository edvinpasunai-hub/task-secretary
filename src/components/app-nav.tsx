"use client";

import { Archive, LayoutDashboard, ListTodo, Tags, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard, match: (path: string) => path === "/" },
  { href: "/tasks", label: "Tasks", Icon: ListTodo, match: (path: string) => path.startsWith("/tasks") },
  { href: "/categories", label: "Categories", Icon: Tags, match: (path: string) => path.startsWith("/categories") },
  { href: "/archive", label: "Archive", Icon: Archive, match: (path: string) => path.startsWith("/archive") },
  { href: "/trash", label: "Trash", Icon: Trash2, match: (path: string) => path.startsWith("/trash") },
] as const;

// The main navigation.
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 pb-2">
      {LINKS.map(({ href, label, Icon, match }) => {
        const current = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            title={label}
            className={cn(
              "flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:px-3",
              current && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {/* On a phone only the current page shows its name, so all five tabs fit without sideways scrolling.
                The name stays in the page for screen readers (and as a tooltip) and is always shown from 640px up. */}
            <span className={cn(!current && "sr-only sm:not-sr-only")}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
