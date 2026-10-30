import { describe, expect, it } from "vitest";

import { classifyTask, compareInSection, DUE_SECTIONS, partitionByDue, type SortableTask } from "@/lib/dashboard/sections";

const now = { date: "2026-11-10", time: "14:30" }; // a Tuesday afternoon

const task = (deadlineDate: string | null, deadlineTime: string | null = null, o: Partial<SortableTask> = {}): SortableTask => ({
  id: "t1",
  status: "TODO",
  priority: "MEDIUM",
  createdAt: "2026-11-01T10:00:00.000Z",
  deadlineDate,
  deadlineTime,
  ...o,
});

describe("classifyTask", () => {
  it("has no section for completed tasks, whatever their deadline", () => {
    expect(classifyTask(task("2026-11-01", null, { status: "COMPLETED" }), now)).toBeNull();
    expect(classifyTask(task(null, null, { status: "COMPLETED" }), now)).toBeNull();
  });

  it("no deadline -> none (a planned date is not a due date)", () => {
    expect(classifyTask(task(null), now)).toBe("none");
  });

  it("a deadline on an earlier day is overdue", () => {
    expect(classifyTask(task("2026-11-09"), now)).toBe("overdue");
    expect(classifyTask(task("2025-01-01"), now)).toBe("overdue");
  });

  it("a timed deadline today is today until its minute has passed, then overdue", () => {
    expect(classifyTask(task("2026-11-10", "14:31"), now)).toBe("today");
    expect(classifyTask(task("2026-11-10", "14:30"), now)).toBe("today"); // the existing rule: overdue only once passed
    expect(classifyTask(task("2026-11-10", "14:29"), now)).toBe("overdue");
    expect(classifyTask(task("2026-11-10", "09:00"), now)).toBe("overdue");
  });

  it("a date-only deadline today is today until the end of the day", () => {
    expect(classifyTask(task("2026-11-10"), now)).toBe("today");
    expect(classifyTask(task("2026-11-10"), { date: "2026-11-10", time: "23:59" })).toBe("today");
    expect(classifyTask(task("2026-11-10"), { date: "2026-11-11", time: "00:00" })).toBe("overdue");
  });

  it("the next seven days (not today) are upcoming; the eighth day is later", () => {
    expect(classifyTask(task("2026-11-11"), now)).toBe("upcoming");
    expect(classifyTask(task("2026-11-17"), now)).toBe("upcoming"); // today + 7
    expect(classifyTask(task("2026-11-18"), now)).toBe("later"); // today + 8
    expect(classifyTask(task("2027-03-01"), now)).toBe("later");
  });

  it("the window is calendar days: it crosses month and year ends", () => {
    const eve = { date: "2026-12-28", time: "10:00" };
    expect(classifyTask(task("2027-01-04"), eve)).toBe("upcoming"); // +7
    expect(classifyTask(task("2027-01-05"), eve)).toBe("later");
  });

  it("works across the clock-change days (calendar days, not 24-hour blocks)", () => {
    const spring = { date: "2026-03-28", time: "23:00" }; // the clocks go forward the next night
    expect(classifyTask(task("2026-04-04"), spring)).toBe("upcoming");
    expect(classifyTask(task("2026-04-05"), spring)).toBe("later");
    const autumn = { date: "2026-10-24", time: "23:00" };
    expect(classifyTask(task("2026-10-31"), autumn)).toBe("upcoming");
    expect(classifyTask(task("2026-11-01"), autumn)).toBe("later");
  });

  it("agrees with the existing Overdue badge rule for every status that is not completed", () => {
    for (const status of ["TODO", "IN_PROGRESS", "POSTPONED"] as const) {
      expect(classifyTask(task("2026-11-09", null, { status }), now)).toBe("overdue");
    }
  });
});

describe("partitionByDue", () => {
  it("puts every unfinished task in exactly one section and leaves out completed ones", () => {
    const all: SortableTask[] = [];
    const dates = [null, "2025-12-31", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-17", "2026-11-18", "2030-01-01"];
    const times = [null, "00:00", "09:00", "14:29", "14:30", "14:31", "23:59"];
    let n = 0;
    for (const date of dates) for (const time of times) for (const status of ["TODO", "IN_PROGRESS", "POSTPONED", "COMPLETED"] as const) {
      if (date === null && time !== null) continue;
      all.push(task(date, time, { id: `t${n++}`, status }));
    }
    const sections = partitionByDue(all, now);
    const placed = DUE_SECTIONS.flatMap((section) => sections[section].map((t) => t.id));
    expect(new Set(placed).size).toBe(placed.length); // never in two sections
    expect(placed.sort()).toEqual(all.filter((t) => t.status !== "COMPLETED").map((t) => t.id).sort()); // and never lost
  });

  it("sorts overdue by the oldest deadline first", () => {
    const sections = partitionByDue([task("2026-11-09", null, { id: "b" }), task("2026-11-01", null, { id: "a" }), task("2026-11-10", "09:00", { id: "c" })], now);
    expect(sections.overdue.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts today by time (timed first, date-only last), then priority", () => {
    const sections = partitionByDue(
      [
        task("2026-11-10", null, { id: "dateOnly" }),
        task("2026-11-10", "18:00", { id: "evening" }),
        task("2026-11-10", "15:00", { id: "afternoonLow", priority: "LOW" }),
        task("2026-11-10", "15:00", { id: "afternoonHigh", priority: "HIGH" }),
      ],
      now,
    );
    expect(sections.today.map((t) => t.id)).toEqual(["afternoonHigh", "afternoonLow", "evening", "dateOnly"]);
  });

  it("sorts upcoming by date, and no-due-date by priority then age", () => {
    const sections = partitionByDue(
      [
        task("2026-11-15", null, { id: "late" }),
        task("2026-11-12", null, { id: "early" }),
        task(null, null, { id: "oldNormal", createdAt: "2026-10-01T00:00:00.000Z" }),
        task(null, null, { id: "newNormal", createdAt: "2026-11-01T00:00:00.000Z" }),
        task(null, null, { id: "high", priority: "HIGH", createdAt: "2026-11-05T00:00:00.000Z" }),
      ],
      now,
    );
    expect(sections.upcoming.map((t) => t.id)).toEqual(["early", "late"]);
    expect(sections.none.map((t) => t.id)).toEqual(["high", "oldNormal", "newNormal"]);
  });

  it("is deterministic for ties (falls back to the id)", () => {
    const a = task("2026-11-12", null, { id: "a" });
    const b = task("2026-11-12", null, { id: "b" });
    expect(compareInSection("upcoming")(a, b)).toBeLessThan(0);
    expect(partitionByDue([b, a], now).upcoming.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
