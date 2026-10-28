import "server-only";

import type { Category } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { CategoryView, TaskCategory } from "@/lib/category-rules";
import { categoryIdSchema } from "@/lib/category-validation";
import { requireUser } from "@/lib/session";

export const categoryWithTaskCount = (userId: string) =>
  ({
    // Count only the owner's tasks.
    _count: { select: { tasks: { where: { userId } } } },
  }) as const;

export function toCategoryView(category: Category & { _count: { tasks: number } }): CategoryView {
  return { id: category.id, name: category.name, color: category.color, taskCount: category._count.tasks };
}

// Resolves the logged-in user itself, so callers cannot ask for another
// user's categories. Sorted by name, ignoring upper/lower case.
export async function getMyCategories(): Promise<CategoryView[]> {
  const user = await requireUser();
  const categories = await prisma.category.findMany({
    where: { userId: user.id },
    include: categoryWithTaskCount(user.id),
    orderBy: [{ normalizedName: "asc" }, { createdAt: "asc" }],
  });
  return categories.map(toCategoryView);
}

// One of the logged-in user's own categories, or null. A malformed id, an id
// that does not exist and another user's category all give the same null, so
// the answer never reveals whether someone else owns it.
export async function getMyCategory(id: string): Promise<TaskCategory | null> {
  const user = await requireUser();
  if (!categoryIdSchema.safeParse(id).success) return null;
  return prisma.category.findFirst({ where: { id, userId: user.id }, select: { id: true, name: true, color: true } });
}
