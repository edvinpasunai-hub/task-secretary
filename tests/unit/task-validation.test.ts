// What the server accepts from the task form (the tampered-input checks of the old test-tasks script).

import { describe, expect, it } from "vitest";

import { parseTaskForm, taskIdSchema, taskStatusSchema } from "@/lib/task-validation";

function form(fields: Record<string, string | File>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const ok = { title: "Write report", priority: "MEDIUM" };

describe("parseTaskForm", () => {
  it("a minimal task: just a title and priority; everything else is empty", () => {
    const result = parseTaskForm(form(ok));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ title: "Write report", description: null, categoryId: null, priority: "MEDIUM", plannedDate: null, plannedTime: null, deadlineDate: null, deadlineTime: null, estimatedMinutes: null });
    }
  });

  it("a full task keeps every field, and the estimate is hours and minutes in minutes", () => {
    const result = parseTaskForm(form({ ...ok, title: "  Trim me  ", description: " text ", priority: "HIGH", plannedDate: "2026-11-12", plannedTime: "09:30", deadlineDate: "2026-11-10", deadlineTime: "17:00", durationHours: "1", durationMinutes: "30" }));
    expect(result.success && result.data).toMatchObject({ title: "Trim me", description: "text", priority: "HIGH", plannedDate: "2026-11-12", plannedTime: "09:30", deadlineDate: "2026-11-10", deadlineTime: "17:00", estimatedMinutes: 90 });
  });

  it("an empty or blank title is refused, and what was typed is kept", () => {
    for (const title of ["", "   "]) {
      const result = parseTaskForm(form({ ...ok, title, description: "typed" }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.title).toBe("Please enter a title.");
        expect(result.values.description).toBe("typed");
      }
    }
  });

  it("a title or description that is too long is refused", () => {
    expect(parseTaskForm(form({ ...ok, title: "x".repeat(201) })).success).toBe(false);
    expect(parseTaskForm(form({ ...ok, title: "x".repeat(200) })).success).toBe(true);
    expect(parseTaskForm(form({ ...ok, description: "x".repeat(5001) })).success).toBe(false);
  });

  it("tampered priority values are refused", () => {
    for (const priority of ["URGENT", "high", "", "HIGH; DROP TABLE", "0"]) {
      const result = parseTaskForm(form({ ...ok, priority }));
      expect(result.success, priority).toBe(false);
      if (!result.success) expect(result.errors.priority).toBeTruthy();
    }
  });

  it("impossible or malformed dates and times are refused", () => {
    for (const date of ["2026-02-30", "2026-13-01", "2026-1-1", "tomorrow", "1999-12-31", "2101-01-01", "2026-11-10T10:00"]) {
      expect(parseTaskForm(form({ ...ok, deadlineDate: date })).success, date).toBe(false);
      expect(parseTaskForm(form({ ...ok, plannedDate: date })).success, date).toBe(false);
    }
    for (const time of ["24:00", "9:30", "12:60", "noon", "12:30:00"]) {
      expect(parseTaskForm(form({ ...ok, deadlineDate: "2026-11-10", deadlineTime: time })).success, time).toBe(false);
    }
  });

  it("a time without a date is refused", () => {
    const result = parseTaskForm(form({ ...ok, deadlineTime: "10:00" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.deadlineTime).toBeTruthy();
    expect(parseTaskForm(form({ ...ok, plannedTime: "10:00" })).success).toBe(false);
  });

  it("a planned date after the deadline is allowed (the app only warns)", () => {
    expect(parseTaskForm(form({ ...ok, plannedDate: "2026-12-01", deadlineDate: "2026-11-10" })).success).toBe(true);
  });

  it("the estimate must be whole numbers within range", () => {
    const bad: Array<Record<string, string>> = [{ durationHours: "-1" }, { durationHours: "1.5" }, { durationHours: "169" }, { durationMinutes: "60" }, { durationMinutes: "abc" }, { durationHours: "168", durationMinutes: "1" }];
    for (const fields of bad) {
      expect(parseTaskForm(form({ ...ok, ...fields })).success, JSON.stringify(fields)).toBe(false);
    }
    expect(parseTaskForm(form({ ...ok, durationHours: "168" })).success).toBe(true);
    const zero = parseTaskForm(form({ ...ok, durationHours: "0", durationMinutes: "0" }));
    expect(zero.success && zero.data.estimatedMinutes).toBeNull(); // zero means "no estimate"
  });

  it("a malformed category id is refused (ownership is checked against the database by the action)", () => {
    expect(parseTaskForm(form({ ...ok, categoryId: "../x" })).success).toBe(false);
    expect(parseTaskForm(form({ ...ok, categoryId: "cmvu1094j0001osk4dtqq9kut" })).success).toBe(true);
  });

  it("ignores fields it does not know: an injected userId, status or id never becomes part of the task", () => {
    const result = parseTaskForm(form({ ...ok, userId: "someone-else", id: "x", status: "COMPLETED", completedAt: "2020-01-01" }));
    expect(result.success).toBe(true);
    if (result.success) expect(Object.keys(result.data).sort()).toEqual(["categoryId", "deadlineDate", "deadlineTime", "description", "estimatedMinutes", "plannedDate", "plannedTime", "priority", "title"]);
  });

  it("a file sent where text is expected is treated as empty", () => {
    const result = parseTaskForm(form({ ...ok, title: new File(["x"], "t.txt") }));
    expect(result.success).toBe(false);
  });
});

describe("ids and statuses", () => {
  it("only well-formed ids pass", () => {
    expect(taskIdSchema.safeParse("cmvu1094j0001osk4dtqq9kut").success).toBe(true);
    for (const id of ["", "x", "../etc/passwd", "CMVU1094J0001OSK4DTQQ9KUT", "a".repeat(41), "id with space1234567890"]) expect(taskIdSchema.safeParse(id).success, id).toBe(false);
  });
  it("only the four statuses pass", () => {
    for (const status of ["TODO", "IN_PROGRESS", "POSTPONED", "COMPLETED"]) expect(taskStatusSchema.safeParse(status).success).toBe(true);
    for (const status of ["DONE", "todo", "", "ARCHIVED", "DELETED"]) expect(taskStatusSchema.safeParse(status).success, status).toBe(false);
  });
});
