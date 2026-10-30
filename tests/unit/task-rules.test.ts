// The core Stage 4.1 task rules (these were only exercised by the old browser script test-tasks).

import { describe, expect, it } from "vitest";

import { applyDeadlineChange, completedAtFor, formatDuration, isOverdue, isPlannedAfterDeadline, isPlannedTimeMissed, type TaskTiming } from "@/lib/task-rules";

const now = { date: "2026-11-10", time: "14:30" };
const timing = (o: Partial<TaskTiming> = {}): TaskTiming => ({ status: "TODO", plannedDate: null, plannedTime: null, deadlineDate: null, deadlineTime: null, ...o });

describe("isOverdue", () => {
  it("is false without a deadline and for completed tasks", () => {
    expect(isOverdue(timing(), now)).toBe(false);
    expect(isOverdue(timing({ status: "COMPLETED", deadlineDate: "2020-01-01" }), now)).toBe(false);
  });
  it("a past deadline date is overdue; today (date-only) is not, until the day is over", () => {
    expect(isOverdue(timing({ deadlineDate: "2026-11-09" }), now)).toBe(true);
    expect(isOverdue(timing({ deadlineDate: "2026-11-10" }), now)).toBe(false);
    expect(isOverdue(timing({ deadlineDate: "2026-11-10" }), { date: "2026-11-10", time: "23:59" })).toBe(false);
    expect(isOverdue(timing({ deadlineDate: "2026-11-10" }), { date: "2026-11-11", time: "00:00" })).toBe(true);
  });
  it("a timed deadline is overdue once its minute has passed", () => {
    expect(isOverdue(timing({ deadlineDate: "2026-11-10", deadlineTime: "14:30" }), now)).toBe(false);
    expect(isOverdue(timing({ deadlineDate: "2026-11-10", deadlineTime: "14:29" }), now)).toBe(true);
    expect(isOverdue(timing({ deadlineDate: "2026-11-10", deadlineTime: "18:00" }), now)).toBe(false);
  });
  it("applies to every unfinished status", () => {
    for (const status of ["TODO", "IN_PROGRESS", "POSTPONED"] as const) expect(isOverdue(timing({ status, deadlineDate: "2026-11-01" }), now)).toBe(true);
  });
});

describe("isPlannedTimeMissed (a hint, never 'overdue')", () => {
  it("is true when the planned moment has passed and work has not started", () => {
    expect(isPlannedTimeMissed(timing({ plannedDate: "2026-11-09" }), now)).toBe(true);
    expect(isPlannedTimeMissed(timing({ plannedDate: "2026-11-10", plannedTime: "09:00" }), now)).toBe(true);
    expect(isPlannedTimeMissed(timing({ status: "POSTPONED", plannedDate: "2026-11-09" }), now)).toBe(true);
  });
  it("is false for a planned time still ahead, a date-only plan for today, started or finished work, and no plan", () => {
    expect(isPlannedTimeMissed(timing({ plannedDate: "2026-11-10", plannedTime: "18:00" }), now)).toBe(false);
    expect(isPlannedTimeMissed(timing({ plannedDate: "2026-11-10" }), now)).toBe(false);
    expect(isPlannedTimeMissed(timing({ status: "IN_PROGRESS", plannedDate: "2026-11-01" }), now)).toBe(false);
    expect(isPlannedTimeMissed(timing({ status: "COMPLETED", plannedDate: "2026-11-01" }), now)).toBe(false);
    expect(isPlannedTimeMissed(timing(), now)).toBe(false);
  });
  it("a missed plan is not an overdue task", () => {
    const task = timing({ plannedDate: "2026-11-01", deadlineDate: "2026-11-30" });
    expect(isPlannedTimeMissed(task, now)).toBe(true);
    expect(isOverdue(task, now)).toBe(false);
  });
});

describe("isPlannedAfterDeadline (a warning only)", () => {
  it("compares planned start with the end of the deadline", () => {
    expect(isPlannedAfterDeadline({ plannedDate: "2026-11-12", plannedTime: null, deadlineDate: "2026-11-10", deadlineTime: null })).toBe(true);
    expect(isPlannedAfterDeadline({ plannedDate: "2026-11-10", plannedTime: "18:00", deadlineDate: "2026-11-10", deadlineTime: "17:00" })).toBe(true);
    expect(isPlannedAfterDeadline({ plannedDate: "2026-11-10", plannedTime: "16:00", deadlineDate: "2026-11-10", deadlineTime: "17:00" })).toBe(false);
    expect(isPlannedAfterDeadline({ plannedDate: "2026-11-10", plannedTime: null, deadlineDate: "2026-11-10", deadlineTime: null })).toBe(false); // the same whole day
    expect(isPlannedAfterDeadline({ plannedDate: "2026-11-09", plannedTime: null, deadlineDate: "2026-11-10", deadlineTime: null })).toBe(false);
  });
  it("is false when either date is missing", () => {
    expect(isPlannedAfterDeadline({ plannedDate: null, plannedTime: null, deadlineDate: "2026-11-10", deadlineTime: null })).toBe(false);
    expect(isPlannedAfterDeadline({ plannedDate: "2026-11-12", plannedTime: null, deadlineDate: null, deadlineTime: null })).toBe(false);
  });
});

describe("applyDeadlineChange (reschedule counting)", () => {
  const base = { deadlineDate: "2026-11-10", originalDeadlineDate: "2026-11-10", rescheduleCount: 0 };
  it("the very first deadline is remembered and is not a reschedule", () => {
    expect(applyDeadlineChange({ deadlineDate: null, originalDeadlineDate: null, rescheduleCount: 0 }, "2026-11-10")).toEqual({ originalDeadlineDate: "2026-11-10", rescheduleCount: 0 });
  });
  it("changing the date counts one reschedule and keeps the original deadline", () => {
    expect(applyDeadlineChange(base, "2026-11-15")).toEqual({ originalDeadlineDate: "2026-11-10", rescheduleCount: 1 });
    expect(applyDeadlineChange({ ...base, deadlineDate: "2026-11-15", rescheduleCount: 1 }, "2026-11-20")).toEqual({ originalDeadlineDate: "2026-11-10", rescheduleCount: 2 });
  });
  it("keeping the same date (for example changing only the time) does not count", () => {
    expect(applyDeadlineChange(base, "2026-11-10")).toEqual({ originalDeadlineDate: "2026-11-10", rescheduleCount: 0 });
  });
  it("removing the deadline counts, and adding one back counts again", () => {
    const removed = applyDeadlineChange(base, null);
    expect(removed).toEqual({ originalDeadlineDate: "2026-11-10", rescheduleCount: 1 });
    expect(applyDeadlineChange({ deadlineDate: null, ...removed }, "2026-11-12")).toEqual({ originalDeadlineDate: "2026-11-10", rescheduleCount: 2 });
  });
});

describe("completedAtFor", () => {
  const moment = new Date("2026-11-10T12:00:00Z");
  const earlier = new Date("2026-11-01T08:00:00Z");
  it("sets the time when a task becomes completed", () => {
    expect(completedAtFor({ status: "TODO", completedAt: null }, "COMPLETED", moment)).toBe(moment);
    expect(completedAtFor({ status: "IN_PROGRESS", completedAt: null }, "COMPLETED", moment)).toBe(moment);
  });
  it("keeps the original time when it is saved as completed again", () => {
    expect(completedAtFor({ status: "COMPLETED", completedAt: earlier }, "COMPLETED", moment)).toBe(earlier);
  });
  it("clears it when the task is reopened", () => {
    for (const next of ["TODO", "IN_PROGRESS", "POSTPONED"] as const) expect(completedAtFor({ status: "COMPLETED", completedAt: earlier }, next, moment)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("shows minutes, whole hours and both", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30 min");
    expect(formatDuration(168 * 60)).toBe("168 h");
  });
});
