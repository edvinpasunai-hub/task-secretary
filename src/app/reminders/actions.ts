"use server";

import { idSchema } from "@/lib/recurrence/validation";
import { getReminders, markAllRemindersRead, markReminderRead, snoozeReminder, type RemindersView } from "@/lib/reminders/service";
import { requireUser } from "@/lib/session";

// The notification bell's actions. Server Actions are public endpoints, so each one
// resolves the logged-in user itself and accepts only a plain reminder id. Each returns
// the fresh list so the bell updates without reloading the page.

export async function refreshRemindersAction(): Promise<RemindersView> {
  const user = await requireUser();
  return getReminders({ userId: user.id });
}

export async function markReminderReadAction(id: unknown): Promise<RemindersView> {
  const user = await requireUser();
  const parsed = idSchema.safeParse(id);
  if (parsed.success) await markReminderRead({ userId: user.id }, parsed.data);
  return getReminders({ userId: user.id });
}

export async function snoozeReminderAction(id: unknown): Promise<RemindersView> {
  const user = await requireUser();
  const parsed = idSchema.safeParse(id);
  if (parsed.success) await snoozeReminder({ userId: user.id }, parsed.data);
  return getReminders({ userId: user.id });
}

export async function markAllRemindersReadAction(): Promise<RemindersView> {
  const user = await requireUser();
  await markAllRemindersRead({ userId: user.id });
  return getReminders({ userId: user.id });
}
