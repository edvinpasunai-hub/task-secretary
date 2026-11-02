// Stage 6.3: Secretary's Focus: the one-line explanations, the due-date labels and the display rows. The order and the
// breakdown always come from the REAL Stage 6.2 rankTasks; nothing here re-scores a task.

import { describe, expect, it } from "vitest";

import { dueLabel, explainRecommendation, FOCUS_LIMIT, toFocusItems, type ExplainInput } from "@/lib/ranking/focus";
import { rankTasks, URGENCY_LEVELS, type RankableTask } from "@/lib/ranking/ranking";

// Tuesday 10 Nov 2026, 14:30 in Europe/Tallinn.
const NOW = new Date("2026-11-10T12:30:00Z");
const TODAY = "2026-11-10";
const ctx = { now: NOW, timeZone: "Europe/Tallinn" };

let counter = 0;
type T = RankableTask & { title: string };
const task = (o: Partial<T> = {}): T => ({
  id: `focus${String(++counter).padStart(4, "0")}`,
  title: `Task ${counter}`,
  status: "TODO",
  priority: "MEDIUM",
  createdAt: "2026-11-09T08:00:00.000Z",
  deadlineDate: null,
  deadlineTime: null,
  ...o,
});
const input = (o: Partial<ExplainInput>): ExplainInput => ({ priority: "MEDIUM", level: "NONE", ageDays: 0, daysUntilDue: null, ...o });

describe("the explanation line", () => {
  it("overdue: High priority says so; others are 'Overdue and needs attention'", () => {
    expect(explainRecommendation(input({ priority: "HIGH", level: "OVERDUE" }))).toBe("High priority and overdue");
    expect(explainRecommendation(input({ priority: "MEDIUM", level: "OVERDUE" }))).toBe("Overdue and needs attention");
    expect(explainRecommendation(input({ priority: "LOW", level: "OVERDUE" }))).toBe("Overdue and needs attention");
  });

  it("due today and due tomorrow are never mixed up", () => {
    expect(explainRecommendation(input({ priority: "HIGH", level: "TODAY" }))).toBe("High priority and due today");
    expect(explainRecommendation(input({ priority: "MEDIUM", level: "TODAY" }))).toBe("Due today");
    expect(explainRecommendation(input({ priority: "HIGH", level: "TOMORROW" }))).toBe("High priority, due tomorrow");
    expect(explainRecommendation(input({ priority: "LOW", level: "TOMORROW" }))).toBe("Due tomorrow");
  });

  it("due in 2-3 days names the real number of days; later names the priority and the real days", () => {
    expect(explainRecommendation(input({ priority: "HIGH", level: "SOON", daysUntilDue: 2 }))).toBe("High priority, due in 2 days");
    expect(explainRecommendation(input({ priority: "MEDIUM", level: "SOON", daysUntilDue: 3 }))).toBe("Due in 3 days");
    expect(explainRecommendation(input({ priority: "HIGH", level: "LATER", daysUntilDue: 12 }))).toBe("High priority, due in 12 days");
    expect(explainRecommendation(input({ priority: "MEDIUM", level: "LATER", daysUntilDue: 30 }))).toBe("Medium priority, due in 30 days");
    expect(explainRecommendation(input({ priority: "LOW", level: "LATER", daysUntilDue: 4 }))).toBe("Low priority, due in 4 days");
  });

  it("no due date: how long it has been waiting, in the same bands as the ranking's age bonus", () => {
    const waiting = (ageDays: number, priority: ExplainInput["priority"] = "MEDIUM") => explainRecommendation(input({ priority, ageDays }));
    for (const age of [0, 1, 6]) expect(waiting(age), `${age}`).toBe("Medium priority, no due date");
    for (const age of [7, 13]) expect(waiting(age), `${age}`).toBe("Waiting for 7+ days");
    for (const age of [14, 29]) expect(waiting(age), `${age}`).toBe("Waiting for 14+ days");
    for (const age of [30, 59]) expect(waiting(age), `${age}`).toBe("Waiting for 30+ days");
    for (const age of [60, 61, 400]) expect(waiting(age), `${age}`).toBe("Waiting for 60+ days");
    expect(waiting(0, "HIGH")).toBe("High priority, no due date");
    expect(waiting(45, "HIGH")).toBe("High priority, waiting for 30+ days");
    expect(waiting(0, "LOW")).toBe("Low priority, no due date");
    expect(waiting(20, "LOW")).toBe("Waiting for 14+ days");
  });

  it("is always one short line", () => {
    for (const priority of ["HIGH", "MEDIUM", "LOW"] as const) {
      for (const level of URGENCY_LEVELS) {
        for (const ageDays of [0, 8, 20, 40, 90]) {
          const text = explainRecommendation({ priority, level, ageDays, daysUntilDue: 5 });
          expect(text, `${priority} ${level} ${ageDays}`).not.toMatch(/[\n\r]/);
          expect(text.length).toBeLessThanOrEqual(48);
        }
      }
    }
  });

  it("never claims what is not true (every priority x every level)", () => {
    for (const priority of ["HIGH", "MEDIUM", "LOW"] as const) {
      for (const level of URGENCY_LEVELS) {
        const text = explainRecommendation({ priority, level, ageDays: 100, daysUntilDue: 6 });
        const lower = text.toLowerCase();
        if (level !== "OVERDUE") expect(lower, `${priority} ${level}`).not.toContain("overdue"); // incl. every task without a due date
        if (level !== "TODAY") expect(lower, `${priority} ${level}`).not.toContain("today");
        if (level !== "TOMORROW") expect(lower, `${priority} ${level}`).not.toContain("tomorrow");
        if (priority !== "HIGH") expect(text, `${priority} ${level}`).not.toContain("High priority");
        if (level !== "NONE") expect(lower, `${priority} ${level}`).not.toContain("waiting");
        if (level === "NONE") expect(lower, `${priority}`).not.toMatch(/due (today|tomorrow|in)/);
        expect(lower, `${priority} ${level}`).not.toMatch(/urgent|score|points|rank|top/);
      }
    }
  });
});

describe("the due-date label", () => {
  const label = (o: Partial<T>, level: Parameters<typeof dueLabel>[1], today = TODAY) => dueLabel({ deadlineDate: null, deadlineTime: null, ...o }, level, today);

  it("says what is true about the deadline, with the time when there is one", () => {
    expect(label({ deadlineDate: "2026-11-09" }, "OVERDUE")).toBe("Overdue since Mon, 9 Nov");
    expect(label({ deadlineDate: "2026-11-10", deadlineTime: "09:00" }, "OVERDUE")).toBe("Overdue since Tue, 10 Nov, 09:00");
    expect(label({ deadlineDate: "2026-11-10" }, "TODAY")).toBe("Due today");
    expect(label({ deadlineDate: "2026-11-10", deadlineTime: "18:00" }, "TODAY")).toBe("Due today, 18:00");
    expect(label({ deadlineDate: "2026-11-11" }, "TOMORROW")).toBe("Due tomorrow");
    expect(label({ deadlineDate: "2026-11-11", deadlineTime: "08:30" }, "TOMORROW")).toBe("Due tomorrow, 08:30");
    expect(label({ deadlineDate: "2026-11-13" }, "SOON")).toBe("Due Fri, 13 Nov");
    expect(label({ deadlineDate: "2026-12-30", deadlineTime: "12:00" }, "LATER")).toBe("Due Wed, 30 Dec, 12:00");
    expect(label({}, "NONE")).toBe("No due date");
  });

  it("shows the year only when it is not the current one", () => {
    expect(label({ deadlineDate: "2027-01-05" }, "LATER")).toBe("Due Tue, 5 Jan 2027");
    expect(label({ deadlineDate: "2025-12-31" }, "OVERDUE")).toBe("Overdue since Wed, 31 Dec 2025");
  });

  it("a task without a due date has no due text even if given a level that suggests one", () => {
    expect(label({}, "OVERDUE")).toBe("No due date");
  });
});

describe("the Focus rows (from the real ranking)", () => {
  // eight tasks of every kind, scores (for the expected order only): A 110, C 90, B 85, D 75, H 65... see names
  const a = task({ title: "A overdue high", priority: "HIGH", deadlineDate: "2026-11-09" }); //  50 + 60 = 110
  const c = task({ title: "C today high", priority: "HIGH", deadlineDate: "2026-11-10" }); //     50 + 40 =  90
  const b = task({ title: "B overdue medium", priority: "MEDIUM", deadlineDate: "2026-11-08" }); // 25 + 60 =  85
  const d = task({ title: "D tomorrow high", priority: "HIGH", deadlineDate: "2026-11-11" }); //  50 + 25 =  75
  const e = task({ title: "E overdue low", priority: "LOW", deadlineDate: "2026-11-05" }); //       0 + 60 =  60
  const f = task({ title: "F old, no due", priority: "MEDIUM", createdAt: "2026-10-11T07:00:00.000Z" }); // 25 + 15 = 40
  const g = task({ title: "G soon low", priority: "LOW", deadlineDate: "2026-11-13" }); //          0 + 15 =  15
  const h = task({ title: "H new, no due", priority: "LOW" }); //                                   0
  const all = [h, g, f, e, d, c, b, a];

  it("shows exactly five when there are more, in the ranking's order, numbered 1 to 5", () => {
    const items = toFocusItems(rankTasks(all, ctx), TODAY);
    expect(FOCUS_LIMIT).toBe(5);
    expect(items.map((i) => i.title[0])).toEqual(["A", "C", "B", "D", "E"]);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows all of them when there are fewer than five, and nothing at all when there are none", () => {
    expect(toFocusItems(rankTasks([a, f, h], ctx), TODAY).map((i) => i.title[0])).toEqual(["A", "F", "H"]);
    expect(toFocusItems(rankTasks([h], ctx), TODAY)).toHaveLength(1);
    expect(toFocusItems(rankTasks([], ctx), TODAY)).toEqual([]);
    expect(toFocusItems(rankTasks([task({ status: "COMPLETED", priority: "HIGH", deadlineDate: "2026-11-01" })], ctx), TODAY)).toEqual([]);
  });

  it("each row carries the real priority, due text and a matching reason", () => {
    const items = toFocusItems(rankTasks(all, ctx), TODAY, 8);
    const by = (letter: string) => items.find((i) => i.title.startsWith(letter))!;
    expect(by("A")).toMatchObject({ priority: "HIGH", priorityLabel: "High", dueLabel: "Overdue since Mon, 9 Nov", reason: "High priority and overdue" });
    expect(by("C")).toMatchObject({ priorityLabel: "High", dueLabel: "Due today", reason: "High priority and due today" });
    expect(by("B")).toMatchObject({ priorityLabel: "Medium", dueLabel: "Overdue since Sun, 8 Nov", reason: "Overdue and needs attention" });
    expect(by("D")).toMatchObject({ priorityLabel: "High", dueLabel: "Due tomorrow", reason: "High priority, due tomorrow" });
    expect(by("E")).toMatchObject({ priorityLabel: "Low", dueLabel: "Overdue since Thu, 5 Nov", reason: "Overdue and needs attention" });
    expect(by("F")).toMatchObject({ priorityLabel: "Medium", dueLabel: "No due date", reason: "Waiting for 30+ days" });
    expect(by("G")).toMatchObject({ priorityLabel: "Low", dueLabel: "Due Fri, 13 Nov", reason: "Due in 3 days" });
    expect(by("H")).toMatchObject({ priorityLabel: "Low", dueLabel: "No due date", reason: "Low priority, no due date" });
  });

  it("a task without a due date is never described as overdue, and one due tomorrow never as due today", () => {
    for (const item of toFocusItems(rankTasks(all, ctx), TODAY, 8)) {
      if (item.dueLabel === "No due date") expect(`${item.reason} ${item.dueLabel}`.toLowerCase()).not.toContain("overdue");
      if (item.dueLabel.startsWith("Due tomorrow")) expect(item.reason.toLowerCase()).not.toContain("today");
    }
  });

  it("exposes no score, points, breakdown or other task fields: only what is shown", () => {
    const [item] = toFocusItems(rankTasks(all, ctx), TODAY);
    expect(Object.keys(item).sort()).toEqual(["dueLabel", "id", "priority", "priorityLabel", "rank", "reason", "title"]);
    expect(JSON.stringify(item)).not.toMatch(/score|points|breakdown|createdAt|description/i);
  });

  it("does not change the ranking input", () => {
    const frozen = Object.freeze(all.map((t) => Object.freeze({ ...t })));
    const before = JSON.stringify(frozen);
    toFocusItems(rankTasks(frozen, ctx), TODAY);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("follows the day boundaries of Stage 6.2, including the clock change (29 Mar 2026 is a 23-hour day)", () => {
    const due = task({ title: "due on the 30th", priority: "HIGH", deadlineDate: "2026-03-30" });
    // today (as the dashboard computes it) is the user's local date: 29 Mar until local midnight, then 30 Mar
    const row = (iso: string, today: string) => toFocusItems(rankTasks([due], { now: new Date(iso), timeZone: "Europe/Tallinn" }), today)[0];
    expect(row("2026-03-29T20:59:59Z", "2026-03-29")).toMatchObject({ dueLabel: "Due tomorrow", reason: "High priority, due tomorrow" });
    expect(row("2026-03-29T21:00:00Z", "2026-03-30")).toMatchObject({ dueLabel: "Due today", reason: "High priority and due today" });
  });

  it("the same moment is a different day in a different zone, and the wording follows", () => {
    const due = task({ priority: "HIGH", deadlineDate: "2026-11-11" });
    const moment = new Date("2026-11-10T22:30:00Z"); // 00:30 on the 11th in Tallinn, 17:30 on the 10th in New York
    expect(toFocusItems(rankTasks([due], { now: moment, timeZone: "Europe/Tallinn" }), "2026-11-11")[0].reason).toBe("High priority and due today");
    expect(toFocusItems(rankTasks([due], { now: moment, timeZone: "America/New_York" }), "2026-11-10")[0].reason).toBe("High priority, due tomorrow");
  });
});
