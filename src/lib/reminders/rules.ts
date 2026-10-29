// When reminders for a deadline appear. Pure functions (no database), so the time
// rules are easy to test, including the days the clocks change.
//
// - DAY_BEFORE: 09:00 on the calendar day before the deadline date.
// - DUE_DAY:    09:00 on the deadline date.
// All times are Europe/Tallinn wall-clock times, whatever the deadline's own time of day.

import { nowInTimeZone, type LocalDate } from "@/lib/local-time";
import { addDays } from "@/lib/recurrence/civil-date";
import { wallClockToInstant } from "@/lib/recurrence/zoned-time";

export const REMINDER_TIME_ZONE = "Europe/Tallinn";
export const REMINDER_TIME = "09:00";
// "Remind Later" hides a reminder for this long.
export const SNOOZE_MS = 4 * 60 * 60 * 1000;
// Reminders older than this (counted from when they became due) leave the list.
export const KEEP_DAYS = 7;
export const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;

export type ReminderTypeName = "DAY_BEFORE" | "DUE_DAY";

export type ReminderSlot = { type: ReminderTypeName; forDueDate: LocalDate; scheduledAt: Date };

const at9 = (date: LocalDate) => new Date(wallClockToInstant(date, REMINDER_TIME, REMINDER_TIME_ZONE));

// The two moments reminders belong to for a deadline date.
export function reminderSlots(deadlineDate: LocalDate): ReminderSlot[] {
  return [
    { type: "DAY_BEFORE", forDueDate: deadlineDate, scheduledAt: at9(addDays(deadlineDate, -1)) },
    { type: "DUE_DAY", forDueDate: deadlineDate, scheduledAt: at9(deadlineDate) },
  ];
}

// The reminders that should exist for this deadline right now.
// - A moment that has not come yet creates nothing (it is created once it has passed).
// - A deadline in the past creates nothing: no historical reminders.
// - On the deadline day itself the "tomorrow" reminder is skipped, because its moment
//   is over and the due-day reminder says it better.
// A deadline set after 09:00 of the day before is therefore reminded at once ("late
// reminders show immediately"), and a moment missed while the app was closed is still
// created when the app opens.
export function dueSlots(deadlineDate: LocalDate, now: Date): ReminderSlot[] {
  const today = nowInTimeZone(REMINDER_TIME_ZONE, now).date;
  if (deadlineDate < today) return [];
  return reminderSlots(deadlineDate).filter(
    (slot) => slot.scheduledAt.getTime() <= now.getTime() && !(slot.type === "DAY_BEFORE" && deadlineDate === today),
  );
}

// The only deadline dates that can need a new reminder right now: today and tomorrow.
export function relevantDeadlineDates(now: Date): [LocalDate, LocalDate] {
  const today = nowInTimeZone(REMINDER_TIME_ZONE, now).date;
  return [today, addDays(today, 1)];
}
