// Stage 6.1: the task priority (High / Medium / Low, default Medium) as the app defines and validates it.

import { describe, expect, it } from "vitest";

import { Priority } from "@/generated/prisma/enums";
import { PRIORITY_LABELS, PRIORITY_LEVELS } from "@/lib/task-rules";
import { parseTaskForm } from "@/lib/task-validation";
import { seriesPatchSchema } from "@/lib/recurrence/validation";
import { compareInSection, type SortableTask } from "@/lib/dashboard/sections";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ title: "Write report", ...fields })) data.set(key, value);
  return data;
};

describe("the priority values", () => {
  it("are exactly HIGH, MEDIUM, LOW, in that order, with the same names in the database client", () => {
    expect([...PRIORITY_LEVELS]).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(Object.values(Priority)).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("have plain labels (High, Medium, Low); the old 'Normal' is gone", () => {
    expect(PRIORITY_LABELS).toEqual({ HIGH: "High", MEDIUM: "Medium", LOW: "Low" });
    expect(Object.values(PRIORITY_LABELS)).not.toContain("Normal");
  });
});

describe("priority validation (the server's check of the form)", () => {
  it("accepts each of the three values", () => {
    for (const priority of PRIORITY_LEVELS) {
      const result = parseTaskForm(form({ priority }));
      expect(result.success, priority).toBe(true);
      if (result.success) expect(result.data.priority).toBe(priority);
    }
  });

  it("refuses the old value NORMAL and anything forged, with a clear message, and keeps the other typed values", () => {
    for (const priority of ["NORMAL", "URGENT", "high", "Medium", "", " HIGH", "HIGH ", "HIGH;DROP TABLE tasks", "0", "1", "null", "__proto__"]) {
      const result = parseTaskForm(form({ priority, description: "typed text" }));
      expect(result.success, JSON.stringify(priority)).toBe(false);
      if (!result.success) {
        expect(result.errors.priority).toBe("Please choose High, Medium or Low.");
        expect(result.values.description).toBe("typed text");
      }
    }
  });

  it("refuses a form that has no priority at all (for example a stale page from before the rename)", () => {
    const result = parseTaskForm(form({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.priority).toBeTruthy();
    const stale = parseTaskForm(form({ importance: "HIGH" })); // the old field name is not accepted
    expect(stale.success).toBe(false);
  });

  it("a file or repeated field cannot smuggle another value", () => {
    const data = form({ priority: "LOW" });
    data.append("priority", "HIGH");
    const result = parseTaskForm(data);
    expect(result.success && result.data.priority).toBe("LOW"); // the first value is the one read
    expect(parseTaskForm(form({ priority: new File(["HIGH"], "p.txt") as unknown as string })).success).toBe(false);
  });

  it("the repeating-series patch accepts only the three values", () => {
    for (const priority of PRIORITY_LEVELS) expect(seriesPatchSchema.safeParse({ priority }).success).toBe(true);
    for (const priority of ["NORMAL", "URGENT", "", null]) expect(seriesPatchSchema.safeParse({ priority }).success, String(priority)).toBe(false);
    expect(seriesPatchSchema.safeParse({ importance: "HIGH" }).success).toBe(false);
  });
});

describe("priority and ordering", () => {
  const task = (id: string, priority: SortableTask["priority"]): SortableTask => ({ id, priority, status: "TODO", createdAt: "2026-11-01T00:00:00.000Z", deadlineDate: "2026-11-12", deadlineTime: null });
  it("on the same deadline, High comes before Medium before Low", () => {
    const sorted = [task("c", "LOW"), task("a", "HIGH"), task("b", "MEDIUM")].sort(compareInSection("upcoming"));
    expect(sorted.map((t) => t.priority)).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });
  it("the deadline still comes first: priority never overrides an earlier deadline", () => {
    const early = { ...task("early", "LOW"), deadlineDate: "2026-11-11" };
    const late = { ...task("late", "HIGH"), deadlineDate: "2026-11-15" };
    expect([late, early].sort(compareInSection("upcoming")).map((t) => t.id)).toEqual(["early", "late"]);
  });
});
