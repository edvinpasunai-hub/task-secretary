"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CATEGORY_COLOR_STYLES, type TaskCategory } from "@/lib/category-rules";
import { cn } from "@/lib/utils";

const MISSING = "__missing";

// Chooses which category the task list shows. Changing it navigates to
// "/?category=<id>" (or "/" for all tasks), so the filter lives in the URL:
// it survives a refresh and works with the browser's Back and Forward buttons.
// Remounted by the page whenever the URL's category changes, so it always
// shows what the URL says.
export function CategoryFilter({ categories, current, missing }: { categories: TaskCategory[]; current: string; missing: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState(missing ? MISSING : current);
  const [pending, startTransition] = useTransition();
  const color = categories.find((c) => c.id === selected)?.color;

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    setSelected(value);
    startTransition(() => router.push(value === "" ? "/" : `/?category=${value}`));
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-xs sm:flex-none">
      {/* The options cannot show colours, so the chosen category's colour is shown next to the list. */}
      <span aria-hidden className={cn("size-3 shrink-0 rounded-[3px]", color ? CATEGORY_COLOR_STYLES[color].swatch : "border border-dashed")} data-filter-swatch />
      <select
        id="category-filter"
        aria-label="Filter tasks by category"
        aria-busy={pending}
        value={selected}
        onChange={handleChange}
        className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
      >
        <option value="">All tasks</option>
        {missing && (
          <option value={MISSING} disabled>
            Category not found
          </option>
        )}
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
    </div>
  );
}
