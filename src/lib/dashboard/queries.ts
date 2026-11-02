import "server-only";

import { prisma } from "@/lib/db";
import { todayRange } from "@/lib/dashboard/day";
import { greetingLine } from "@/lib/dashboard/greeting";
import { partitionByDue, type DueSection } from "@/lib/dashboard/sections";
import type { LocalDate, LocalNow } from "@/lib/local-time";
import { toFocusItems, type FocusItem } from "@/lib/ranking/focus";
import { loadRankedTasks } from "@/lib/ranking/queries";
import { requireUser } from "@/lib/session";
import { ACTIVE_TASK } from "@/lib/task-state";
import { runListMaintenance, toTaskView, withCategory, type TaskView } from "@/lib/tasks";

// The most tasks one dashboard section shows. The counts are always the full totals.
export const SECTION_LIMIT = 5;

export type DashboardData = {
  // The user's local date and the current local date and time (for the overdue badges).
  today: LocalDate;
  now: LocalNow;
  // The time-of-day greeting.
  greeting: string;
  // Secretary's Focus: the top-ranked tasks (at most 5), from the Stage 6.2 ranking engine. No scores.
  focus: FocusItem[];
  // The Daily Briefing numbers.
  briefing: { dueToday: number; overdue: number; completedToday: number };
  // Full number of unfinished tasks in every section (not limited to SECTION_LIMIT).
  counts: Record<DueSection, number>;
  // The first SECTION_LIMIT tasks of the four shown sections, in section order.
  sections: Record<"overdue" | "today" | "upcoming" | "none", TaskView[]>;
};

type DashboardContext = { userId: string; name: string | null; timeZone: string; now?: Date };

// Everything the dashboard shows, for one user, at one moment. Takes the user from the caller (the
// session, never the browser) and only reads that user's tasks.
// - Unfinished tasks: active ones only (not archived, not in Trash), split with the SAME rules the
//   Tasks page filters use, so a task is in exactly one section and "View all" matches the count.
// - Recurring tasks: every open occurrence is one task; nothing is invented for future occurrences.
// - Completed today: tasks completed during the user's current local calendar day (the exact span,
//   also on 23- and 25-hour days). Archived tasks still count; tasks in Trash do not. Reopening a
//   task clears completedAt, so it stops counting.
export async function loadDashboard(ctx: DashboardContext): Promise<DashboardData> {
  const { local, start, end } = todayRange(ctx.now ?? new Date(), ctx.timeZone);

  const [open, completedToday, ranked] = await Promise.all([
    prisma.task.findMany({ where: { userId: ctx.userId, ...ACTIVE_TASK, status: { not: "COMPLETED" } }, include: withCategory }),
    prisma.task.count({ where: { userId: ctx.userId, deletedAt: null, status: "COMPLETED", completedAt: { gte: start, lt: end } } }),
    // The same moment and zone as the rest of the dashboard, so Focus and the sections always agree about "today".
    loadRankedTasks({ userId: ctx.userId, timeZone: ctx.timeZone, now: ctx.now }),
  ]);

  const parts = partitionByDue(open.map(toTaskView), local);
  return {
    today: local.date,
    now: local,
    greeting: greetingLine(local.time, ctx.name),
    focus: toFocusItems(ranked, local.date),
    briefing: { dueToday: parts.today.length, overdue: parts.overdue.length, completedToday },
    counts: { overdue: parts.overdue.length, today: parts.today.length, upcoming: parts.upcoming.length, later: parts.later.length, none: parts.none.length },
    sections: {
      overdue: parts.overdue.slice(0, SECTION_LIMIT),
      today: parts.today.slice(0, SECTION_LIMIT),
      upcoming: parts.upcoming.slice(0, SECTION_LIMIT),
      none: parts.none.slice(0, SECTION_LIMIT),
    },
  };
}

// The logged-in user's dashboard. Brings the same things up to date as the Tasks page does
// (expired pauses, due reminders, expired Trash) so both pages always agree.
export async function getMyDashboard(): Promise<DashboardData> {
  const user = await requireUser();
  await runListMaintenance(user.id);
  return loadDashboard({ userId: user.id, name: user.name, timeZone: user.timeZone });
}
