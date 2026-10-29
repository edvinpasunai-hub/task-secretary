import "server-only";

import type { ReminderType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { dateFromDb, dateToDb, formatLocalDate, nowInTimeZone, timeFromDb } from "@/lib/local-time";
import { addDays } from "@/lib/recurrence/civil-date";
import { dueSlots, KEEP_MS, REMINDER_TIME_ZONE, relevantDeadlineDates, SNOOZE_MS } from "@/lib/reminders/rules";

// In-app reminders. Every function takes the user's id from the caller (the session,
// never the browser) and only touches that user's rows; `now` is a parameter so tests
// can use a fixed clock.
//
// There is no background job. Reminders are created ("reconciled") when the task list
// or the notification bell loads, so reminders missed while the app was closed appear
// the next time it opens.
//
// Duplicates: the database refuses a second (task, type, deadline date) reminder, and
// the insert is ON CONFLICT DO NOTHING, so repeated page loads and simultaneous requests
// create each reminder exactly once.
//
// Staleness: a reminder is only shown while its task is unfinished AND still has the
// deadline date the reminder was made for. Changing a deadline therefore hides the old
// reminders at once and the new date gets its own; completing a task hides them too.

export type ReminderContext = { userId: string; now?: Date };

export type ReminderView = {
  id: string;
  taskId: string;
  title: string;
  // "Due today", "Due tomorrow" or "Due Fri, 30 Oct 2026" as of now.
  headline: string;
  // "Fri, 30 Oct 2026, 14:00"
  deadline: string;
  unread: boolean;
  dueAt: string;
};

export type RemindersView = { unreadCount: number; items: ReminderView[] };

const nowOf = (ctx: ReminderContext) => ctx.now ?? new Date();

// Creates the reminders that have become due for this user's unfinished tasks.
// Returns how many were actually created.
export async function reconcileReminders(ctx: ReminderContext): Promise<number> {
  const now = nowOf(ctx);
  const [today, tomorrow] = relevantDeadlineDates(now);
  const tasks = await prisma.task.findMany({
    where: { userId: ctx.userId, status: { not: "COMPLETED" }, deadlineDate: { in: [dateToDb(today)!, dateToDb(tomorrow)!] } },
    select: { id: true, deadlineDate: true },
  });

  const data = tasks.flatMap((task) =>
    dueSlots(dateFromDb(task.deadlineDate)!, now).map((slot) => ({
      taskId: task.id,
      userId: ctx.userId,
      type: slot.type as ReminderType,
      forDueDate: dateToDb(slot.forDueDate)!,
      scheduledAt: slot.scheduledAt,
    })),
  );
  if (data.length === 0) return 0;
  const result = await prisma.reminder.createMany({ data, skipDuplicates: true });
  return result.count;
}

// The reminders the bell shows: due, not snoozed, recent, for an unfinished task whose
// deadline is still the one the reminder was made for. Newest first. Once the due-day
// reminder of a task exists, its day-before reminder is replaced by it (one entry per task),
// even while the due-day one is snoozed.
export async function listReminders(ctx: ReminderContext): Promise<RemindersView> {
  const now = nowOf(ctx);
  const rows = await prisma.reminder.findMany({
    where: {
      userId: ctx.userId,
      scheduledAt: { lte: now, gte: new Date(now.getTime() - KEEP_MS) },
      task: { status: { not: "COMPLETED" } },
    },
    include: { task: { select: { title: true, deadlineDate: true, deadlineTime: true } } },
    orderBy: [{ scheduledAt: "desc" }, { id: "asc" }],
    take: 100,
  });

  const today = nowInTimeZone(REMINDER_TIME_ZONE, now).date;
  const tomorrow = addDays(today, 1);
  const items: ReminderView[] = [];
  const hasDueDay = new Set(rows.filter((row) => row.type === "DUE_DAY").map((row) => row.taskId + row.forDueDate.toISOString()));
  for (const row of rows) {
    // An outdated Prisma client does not know "readAt" and returns undefined: fail loudly
    // instead of silently showing every reminder as read.
    if (row.readAt === undefined) throw new Error("The Prisma client is out of date (no readAt). Run prisma generate and restart the server.");
    if (row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime()) continue; // snoozed: hidden for now
    if (row.type === "DAY_BEFORE" && hasDueDay.has(row.taskId + row.forDueDate.toISOString())) continue; // replaced by the due-day one
    const deadline = dateFromDb(row.task.deadlineDate);
    if (deadline === null || deadline !== dateFromDb(row.forDueDate)) continue; // the deadline moved
    const time = timeFromDb(row.task.deadlineTime);
    items.push({
      id: row.id,
      taskId: row.taskId,
      title: row.task.title,
      headline: deadline === today ? "Due today" : deadline === tomorrow ? "Due tomorrow" : `Due ${formatLocalDate(deadline)}`,
      deadline: time ? `${formatLocalDate(deadline)}, ${time}` : formatLocalDate(deadline),
      unread: row.readAt === null,
      dueAt: row.scheduledAt.toISOString(),
    });
  }
  return { unreadCount: items.filter((item) => item.unread).length, items };
}

// Reconcile, then list. What the bell calls.
export async function getReminders(ctx: ReminderContext): Promise<RemindersView> {
  await reconcileReminders(ctx);
  return listReminders(ctx);
}

// Only a reminder that is currently due and not snoozed can be changed, and only the
// owner's: the owner filter is part of every write.
const changeable = (ctx: ReminderContext, now: Date) => ({
  userId: ctx.userId,
  scheduledAt: { lte: now },
  OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
});

export async function markReminderRead(ctx: ReminderContext, id: string): Promise<boolean> {
  const now = nowOf(ctx);
  const result = await prisma.reminder.updateMany({ where: { id, ...changeable(ctx, now) }, data: { readAt: now } });
  return result.count > 0;
}

export async function markAllRemindersRead(ctx: ReminderContext): Promise<void> {
  const now = nowOf(ctx);
  // Marks exactly what the list shows, so reminders that are hidden stay untouched.
  const view = await listReminders(ctx);
  const ids = view.items.filter((item) => item.unread).map((item) => item.id);
  if (ids.length > 0) await prisma.reminder.updateMany({ where: { id: { in: ids }, ...changeable(ctx, now), readAt: null }, data: { readAt: now } });
}

// "Remind Later": hidden (list and badge) for 4 hours, then shown again as unread.
export async function snoozeReminder(ctx: ReminderContext, id: string): Promise<boolean> {
  const now = nowOf(ctx);
  const result = await prisma.reminder.updateMany({
    where: { id, ...changeable(ctx, now) },
    data: { snoozedUntil: new Date(now.getTime() + SNOOZE_MS), readAt: null },
  });
  return result.count > 0;
}
