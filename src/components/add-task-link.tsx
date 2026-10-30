"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";

// The header's "Add task" button. The dashboard has its own, larger one, so the header hides it there.
export function AddTaskLink() {
  if (usePathname() === "/") return <span className="ml-auto sm:ml-0" aria-hidden />;
  return (
    <Link href="/tasks/new" className={buttonVariants({ size: "lg", className: "ml-auto sm:ml-0" })} data-add-task>
      <Plus aria-hidden />
      Add task
    </Link>
  );
}
