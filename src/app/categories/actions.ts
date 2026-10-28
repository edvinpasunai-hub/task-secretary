"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { normalizeCategoryName, suggestCategoryColor, type TaskCategory } from "@/lib/category-rules";
import { categoryColorSchema, categoryIdSchema, categoryInputSchema, categoryNameSchema } from "@/lib/category-validation";
import { requireUser } from "@/lib/session";

// Server Actions are public endpoints: every action checks the session itself,
// accepts only plain data, and only ever touches rows where userId is the
// logged-in user's id. A userId sent by the browser is never read.

export type CategoryActionResult = { ok: true; category: TaskCategory } | { ok: false; error: string };
export type DeleteCategoryResult = { ok: true } | { ok: false; error: string };

const SAVE_FAILED = "Sorry, the category could not be saved. Please try again.";
const NOT_FOUND = "This category was not found.";

// Prisma reports a violated unique rule with code P2002.
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

const firstMessage = (error: z.ZodError) => error.issues[0]?.message ?? "Please check the category details.";

async function duplicateMessage(userId: string, name: string) {
  const existing = await prisma.category.findFirst({
    where: { userId, normalizedName: normalizeCategoryName(name) },
    select: { name: true },
  });
  return `You already have a category named “${existing?.name ?? name}”.`;
}

// The database has the final say on duplicates: two simultaneous requests for
// the same name cannot both succeed, because of the unique rule on
// (userId, normalizedName). The loser gets this friendly message.
export async function createCategory(input: unknown): Promise<CategoryActionResult> {
  const user = await requireUser();
  const parsed = categoryInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const { name } = parsed.data;

  try {
    const color =
      parsed.data.color ??
      suggestCategoryColor((await prisma.category.findMany({ where: { userId: user.id }, select: { color: true } })).map((c) => c.color));
    const category = await prisma.category.create({
      data: { userId: user.id, name, normalizedName: normalizeCategoryName(name), color },
      select: { id: true, name: true, color: true },
    });
    revalidatePath("/", "layout");
    return { ok: true, category };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: await duplicateMessage(user.id, name) };
    return { ok: false, error: SAVE_FAILED };
  }
}

const updateInputSchema = z.object({ id: categoryIdSchema, name: categoryNameSchema, color: categoryColorSchema });

export async function updateCategory(input: unknown): Promise<CategoryActionResult> {
  const user = await requireUser();
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const { id, name, color } = parsed.data;

  try {
    // updateMany so the owner check is part of the same statement as the change.
    const { count } = await prisma.category.updateMany({
      where: { id, userId: user.id },
      data: { name, normalizedName: normalizeCategoryName(name), color },
    });
    if (count === 0) return { ok: false, error: NOT_FOUND };
    revalidatePath("/", "layout");
    return { ok: true, category: { id, name, color } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: await duplicateMessage(user.id, name) };
    return { ok: false, error: SAVE_FAILED };
  }
}

// Deleting a category keeps its tasks: the database sets their categoryId to null.
export async function deleteCategory(input: unknown): Promise<DeleteCategoryResult> {
  const user = await requireUser();
  const id = categoryIdSchema.safeParse(input);
  if (!id.success) return { ok: false, error: NOT_FOUND };

  try {
    const { count } = await prisma.category.deleteMany({ where: { id: id.data, userId: user.id } });
    if (count === 0) return { ok: false, error: NOT_FOUND };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch {
    return { ok: false, error: "Sorry, the category could not be deleted. Please try again." };
  }
}
