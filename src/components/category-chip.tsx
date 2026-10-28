import { CATEGORY_COLOR_STYLES, type TaskCategory } from "@/lib/category-rules";
import { cn } from "@/lib/utils";

// A category tag: a small colour square plus the name. The name is always
// shown, so meaning never depends on colour alone. The tag is neutral and
// square-cornered, so it cannot be mistaken for a coloured status pill.
export function CategoryChip({ category, className }: { category: Pick<TaskCategory, "name" | "color">; className?: string }) {
  return (
    <span
      data-category-chip
      title={category.name}
      className={cn("inline-flex h-5 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-background px-1.5 text-xs font-medium", className)}
    >
      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[3px]", CATEGORY_COLOR_STYLES[category.color].swatch)} data-category-swatch />
      <span className="sr-only">Category: </span>
      <span className="truncate">{category.name}</span>
    </span>
  );
}
