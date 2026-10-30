import "server-only";

import { prisma } from "@/lib/db";
import { parseReturn, type ReturnTarget } from "@/lib/return-path";

// The server's last check of a return destination (see src/lib/return-path.ts): a category id in it is
// kept only if it is one of THIS user's categories. Someone else's, a deleted or an unknown category
// all look the same and are simply dropped, so the destination is the plain /tasks list.
export async function resolveReturn(userId: string, target: ReturnTarget): Promise<{ target: ReturnTarget; categoryName: string | null }> {
  if (target.from !== "tasks" || target.category === null) return { target, categoryName: null };
  const category = await prisma.category.findFirst({ where: { id: target.category, userId }, select: { name: true } });
  return category ? { target, categoryName: category.name } : { target: { ...target, category: null }, categoryName: null };
}

// The destination a form was opened from, read from its hidden fields (never from a URL).
export async function returnTargetFromForm(userId: string, formData: FormData): Promise<ReturnTarget> {
  const parsed = parseReturn({ from: formData.get("returnFrom"), due: formData.get("returnDue"), category: formData.get("returnCategory") });
  return (await resolveReturn(userId, parsed)).target;
}
