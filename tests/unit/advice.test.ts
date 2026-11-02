// Stage 6.4: Secretary's Advice: the postponement notes and the overload warning. Pure rules; the ranking underneath is the REAL
// Stage 6.2 rankTasks (nothing is re-scored here).

import { describe, expect, it } from "vitest";

import { OVERLOAD_FROM, overloadAdvice, overloadCount, postponementAdvice, toFocusItems } from "@/lib/ranking/focus";
import { rankTasks, type RankableTask } from "@/lib/ranking/ranking";

const NOW = new Date("2026-11-10T12:30:00Z"); // Tuesday 10 Nov 2026, 14:30 in Europe/Tallinn
const TODAY = "2026-11-10";
const ctx = { now: NOW, timeZone: "Europe/Tallinn" };

let counter = 0;
type T = RankableTask & { title: string; rescheduleCount: number };
const task = (o: Partial<T> = {}): T => ({
  id: `advice${String(++counter).padStart(4, "0")}`,
  title: `Task ${counter}`,
  status: "TODO",
  priority: "MEDIUM",
  createdAt: "2026-11-09T08:00:00.000Z",
  deadlineDate: null,
  deadlineTime: null,
  rescheduleCount: 0,
  ...o,
});

describe("postponement advice", () => {
  it("0, 1 and 2 postponements: no advice", () => {
    for (const n of [0, 1, 2]) expect(postponementAdvice(n)).toBeNull();
  });

  it("3 and 4: the gentle reminder with the real number", () => {
    expect(postponementAdvice(3)).toBe("You've postponed this task 3 times. Consider setting aside time for it.");
    expect(postponementAdvice(4)).toBe("You've postponed this task 4 times. Consider setting aside time for it.");
  });

  it("5 and more: smaller steps or a new deadline, with the real number", () => {
    expect(postponementAdvice(5)).toBe("Postponed 5 times. Consider breaking this task into smaller steps or revisiting its deadline.");
    expect(postponementAdvice(12)).toBe("Postponed 12 times. Consider breaking this task into smaller steps or revisiting its deadline.");
  });

  it("an impossible counter (negative, fractional, NaN) gives no advice", () => {
    for (const n of [-1, 3.5, Number.NaN]) expect(postponementAdvice(n)).toBeNull();
  });
});

describe("advice on the Focus rows", () => {
  it("a row carries the advice of ITS task only, below the (unchanged) ranking reason", () => {
    const tasks = [
      task({ title: "never", priority: "HIGH", deadlineDate: "2026-11-09", rescheduleCount: 1 }),
      task({ title: "gentle", priority: "HIGH", deadlineDate: "2026-11-10", rescheduleCount: 3 }),
      task({ title: "strong", priority: "MEDIUM", deadlineDate: "2026-11-11", rescheduleCount: 7 }),
    ];
    const items = toFocusItems(rankTasks(tasks, ctx), TODAY);
    const by = (t: string) => items.find((i) => i.title === t)!;
    expect(by("never").advice).toBeNull();
    expect(by("gentle").advice).toContain("3 times");
    expect(by("strong").advice).toContain("Postponed 7 times");
    expect(by("gentle").reason).toBe("High priority and due today");
  });

  it("advice exists only for tasks inside the top five (a sixth task with a high count produces no row, hence no advice)", () => {
    const tasks = [
      ...Array.from({ length: 5 }, (_, i) => task({ title: `top ${i}`, priority: "HIGH", deadlineDate: "2026-11-09" })),
      task({ title: "sixth", priority: "LOW", deadlineDate: "2027-01-01", rescheduleCount: 9 }),
    ];
    const items = toFocusItems(rankTasks(tasks, ctx), TODAY);
    expect(items).toHaveLength(5);
    expect(items.some((i) => i.title === "sixth")).toBe(false);
    expect(items.every((i) => i.advice === null)).toBe(true);
  });

  it("a plain ranking input without a counter is treated as 0 (no advice, no crash)", () => {
    const { rescheduleCount, ...bare } = task();
    void rescheduleCount;
    expect(toFocusItems(rankTasks([bare], ctx), TODAY)[0].advice).toBeNull();
  });

  it("the ranking order and the reasons are the same with or without advice (the counter never changes a rank)", () => {
    const base = [task({ title: "a", priority: "HIGH", deadlineDate: "2026-11-09" }), task({ title: "b", priority: "LOW", deadlineDate: "2026-11-10" }), task({ title: "c" })];
    const withCounts = base.map((t, i) => ({ ...t, rescheduleCount: i * 4 }));
    const a = rankTasks(base, ctx);
    const b = rankTasks(withCounts, ctx);
    expect(b.map((r) => [r.task.title, r.score, r.rank])).toEqual(a.map((r) => [r.task.title, r.score, r.rank]));
    expect(toFocusItems(b, TODAY).map((i) => i.reason)).toEqual(toFocusItems(a, TODAY).map((i) => i.reason));
  });

  it("no score appears on a row", () => {
    const row = toFocusItems(rankTasks([task({ rescheduleCount: 6 })], ctx), TODAY)[0];
    expect(Object.keys(row).sort()).toEqual(["advice", "dueLabel", "id", "priority", "priorityLabel", "rank", "reason", "title"]);
  });
});

const overdue = (n: number) => Array.from({ length: n }, () => task({ deadlineDate: "2026-11-05" }));
const today = (n: number) => Array.from({ length: n }, () => task({ deadlineDate: "2026-11-10", deadlineTime: "23:00" }));
const count = (tasks: T[]) => overloadCount(rankTasks(tasks, ctx));

describe("overload count", () => {
  it("counts overdue and due-today tasks, each once, across ALL tasks (not only five)", () => {
    expect(count([...overdue(6), ...today(5)])).toBe(11);
  });

  it("does not count tomorrow, later, or tasks without a due date", () => {
    const others = [task({ deadlineDate: "2026-11-11" }), task({ deadlineDate: "2026-12-01" }), task(), task({ createdAt: "2026-01-01T00:00:00Z" })];
    expect(count([...others, ...overdue(2)])).toBe(2);
  });

  it("a timed deadline earlier today counts as overdue and a later one as due today: both counted once", () => {
    expect(count([task({ deadlineDate: "2026-11-10", deadlineTime: "09:00" }), task({ deadlineDate: "2026-11-10", deadlineTime: "18:00" })])).toBe(2);
  });

  it("completed, archived and trashed tasks are not in the ranking, so they cannot count", () => {
    const hidden = [
      task({ deadlineDate: "2026-11-05", status: "COMPLETED" }),
      task({ deadlineDate: "2026-11-05", archivedAt: "2026-11-01T00:00:00Z" }),
      task({ deadlineDate: "2026-11-05", deletedAt: "2026-11-01T00:00:00Z" }),
    ];
    expect(count([...hidden, ...overdue(1)])).toBe(1);
  });

  it("the day boundary follows the user's time zone (Auckland is already on 11 Nov, so 'due 10 Nov' is overdue there)", () => {
    const tasks = [task({ deadlineDate: "2026-11-10" })];
    expect(overloadCount(rankTasks(tasks, { now: NOW, timeZone: "Pacific/Auckland" }))).toBe(1); // overdue
    expect(overloadCount(rankTasks(tasks, { now: new Date("2026-11-09T22:30:00Z"), timeZone: "Europe/Tallinn" }))).toBe(1); // 00:30 on the 10th: today
    expect(overloadCount(rankTasks(tasks, { now: new Date("2026-11-09T21:30:00Z"), timeZone: "Europe/Tallinn" }))).toBe(0); // 23:30 on the 9th: tomorrow
  });
});

describe("overload warning", () => {
  it("7 or fewer: no warning", () => {
    for (const n of [0, 1, 7]) expect(overloadAdvice(n)).toBeNull();
  });

  it("exactly 8: one warning with the title, the count and the calm message", () => {
    expect(OVERLOAD_FROM).toBe(8);
    expect(overloadAdvice(8)).toEqual({
      count: 8,
      title: "A busy day ahead",
      message: "You have 8 tasks overdue or due today. Consider choosing a few to focus on first.",
    });
  });

  it("9 and more: still a single warning, with the real count", () => {
    expect(overloadAdvice(9)?.message).toBe("You have 9 tasks overdue or due today. Consider choosing a few to focus on first.");
    expect(overloadAdvice(40)?.count).toBe(40);
  });

  it("7 qualifying tasks give none, 8 give one (end to end through the real ranking)", () => {
    expect(overloadAdvice(count([...overdue(4), ...today(3)]))).toBeNull();
    expect(overloadAdvice(count([...overdue(4), ...today(4)]))?.count).toBe(8);
  });
});
