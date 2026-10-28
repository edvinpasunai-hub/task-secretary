// Category rules shared by the server and the browser: the colour palette,
// name normalisation and the automatic default colour. No database access.

import type { CategoryColor } from "@/generated/prisma/enums";

export const MAX_CATEGORY_NAME_LENGTH = 50;

// The palette, in the order colours are handed out by default.
export const CATEGORY_COLORS = ["TEAL", "INDIGO", "PINK", "AMBER", "SKY", "PURPLE", "RED", "LIME"] as const satisfies readonly CategoryColor[];

// Swatches use 600-level shades on light backgrounds (700 for the pale amber
// and lime) and 400-level shades on dark ones, so they keep at least 3:1
// contrast against the card they sit on.
// The class names are written out in full so Tailwind can find them.
export const CATEGORY_COLOR_STYLES: Record<CategoryColor, { label: string; swatch: string }> = {
  TEAL: { label: "Teal", swatch: "bg-teal-600 dark:bg-teal-400" },
  INDIGO: { label: "Indigo", swatch: "bg-indigo-600 dark:bg-indigo-400" },
  PINK: { label: "Pink", swatch: "bg-pink-600 dark:bg-pink-400" },
  AMBER: { label: "Amber", swatch: "bg-amber-700 dark:bg-amber-400" },
  SKY: { label: "Sky", swatch: "bg-sky-600 dark:bg-sky-400" },
  PURPLE: { label: "Purple", swatch: "bg-purple-600 dark:bg-purple-400" },
  RED: { label: "Red", swatch: "bg-red-600 dark:bg-red-400" },
  LIME: { label: "Lime", swatch: "bg-lime-700 dark:bg-lime-400" },
};

// "TMJK", "tmjk" and " TMJK " are the same category name. This one function
// produces the value stored in categories.normalizedName for every write.
export function normalizeCategoryName(name: string): string {
  return name.trim().toLowerCase();
}

// The first palette colour the user is not using yet; once all are used, the
// palette starts over.
export function suggestCategoryColor(usedColors: readonly CategoryColor[]): CategoryColor {
  const unused = CATEGORY_COLORS.find((color) => !usedColors.includes(color));
  return unused ?? CATEGORY_COLORS[usedColors.length % CATEGORY_COLORS.length];
}

// What pages and components receive: plain values, never the owner's id.
export type CategoryView = {
  id: string;
  name: string;
  color: CategoryColor;
  taskCount: number;
};

// The part of a category shown next to a task.
export type TaskCategory = Pick<CategoryView, "id" | "name" | "color">;
