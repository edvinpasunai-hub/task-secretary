"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { postponeTask } from "@/lib/postpone";
import { idSchema } from "@/lib/recurrence/validation";
import { requireUser } from "@/lib/session";

// The Postpone menu's action. A Server Action is a public endpoint: it resolves the logged-in user
// itself, accepts only plain values, and the service only touches that user's active tasks.
// The page refreshes afterwards, so the dashboard counts, the lists and the reminder bell update.

export type PostponeActionResult = { ok: true; message: string } | { ok: false; message: string };

const inputSchema = z.object({ taskId: idSchema, newDate: z.string().max(10), expectedDeadlineDate: z.string().max(10) }).strict();

export async function postponeTaskAction(input: unknown): Promise<PostponeActionResult> {
  const user = await requireUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Please choose a valid date." };
  const result = await postponeTask({ userId: user.id, timeZone: user.timeZone }, parsed.data);
  // Even a refused (stale) request refreshes the page so it shows the current state.
  revalidatePath("/", "layout");
  return { ok: result.ok, message: result.message };
}
