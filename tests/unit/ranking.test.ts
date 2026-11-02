// Stage 6.2: the deterministic ranking engine (src/lib/ranking/ranking.ts). Pure functions, fixed moments, no database.

import { describe, expect, it } from "vitest";

import {
  AGE_BANDS,
  ageBonus,
  ageInDays,
  compareScored,
  isRankable,
  PRIORITY_POINTS,
  rankTasks,
  scoreTask,
  URGENCY_POINTS,
  urgencyLevel,
  type RankableTask,
  type ScoredTask,
} from "@/lib/ranking/ranking";

// Tuesday 10 Nov 2026, 14:30 in Europe/Tallinn (UTC+2 in winter).
const NOW = new Date("2026-11-10T12:30:00Z");
const ctx = { now: NOW, timeZone: "Europe/Tallinn" };

let counter = 0;
// A fresh, low-priority task without a due date (so its score is easy to read), created "today".
const task = (o: Partial<RankableTask> = {}): RankableTask => ({
  id: `t${String(++counter).padStart(4, "0")}`,
  status: "TODO",
  priority: "LOW",
  createdAt: "2026-11-10T08:00:00.000Z",
  deadlineDate: null,
  deadlineTime: null,
  ...o,
});
const score = (o: Partial<RankableTask>, at: Date = NOW, timeZone = "Europe/Tallinn") => scoreTask(task(o), { now: at, timeZone });
const addDaysTo = (date: string, n: number) => new Date(new Date(`${date}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
// A task created `days` calendar days before 10 Nov (at midday UTC, safely inside that local day).
const createdDaysAgo = (days: number) => `${addDaysTo("2026-11-10", -days)}T10:00:00.000Z`;

describe("the scoring table", () => {
  it("has exactly the agreed points", () => {
    expect(PRIORITY_POINTS).toEqual({ HIGH: 50, MEDIUM: 25, LOW: 0 });
    expect(URGENCY_POINTS).toEqual({ OVERDUE: 60, TODAY: 40, TOMORROW: 25, SOON: 15, LATER: 0, NONE: 0 });
    expect(AGE_BANDS.map((b) => [b.minDays, b.points])).toEqual([[60, 20], [30, 15], [14, 10], [7, 5]]);
  });

  it("the highest possible scores: 110 with a due date, 70 without one", () => {
    expect(score({ priority: "HIGH", deadlineDate: "2026-11-01" }).score).toBe(110);
    expect(score({ priority: "HIGH", createdAt: createdDaysAgo(500) }).score).toBe(70);
    expect(score({ priority: "LOW", createdAt: createdDaysAgo(0) }).score).toBe(0);
  });
});

describe("priority points", () => {
  it("HIGH +50, MEDIUM +25, LOW +0 (a new task without a due date has no other points)", () => {
    expect(score({ priority: "HIGH" }).score).toBe(50);
    expect(score({ priority: "MEDIUM" }).score).toBe(25);
    expect(score({ priority: "LOW" }).score).toBe(0);
    expect(score({ priority: "MEDIUM" }).breakdown).toMatchObject({ priority: 25, urgency: 0, urgencyLevel: "NONE", age: 0 });
  });
});

describe("due-date urgency (14:30 on Tuesday 10 Nov)", () => {
  const urgency = (deadlineDate: string | null, deadlineTime: string | null = null) => score({ deadlineDate, deadlineTime }).breakdown;

  it("overdue +60: an earlier day, long ago, or a timed deadline whose minute has passed today", () => {
    expect(urgency("2026-11-09")).toMatchObject({ urgency: 60, urgencyLevel: "OVERDUE" });
    expect(urgency("2020-01-01")).toMatchObject({ urgency: 60, urgencyLevel: "OVERDUE" });
    expect(urgency("2026-11-10", "09:00")).toMatchObject({ urgency: 60, urgencyLevel: "OVERDUE" });
    expect(urgency("2026-11-10", "14:29")).toMatchObject({ urgency: 60, urgencyLevel: "OVERDUE" });
  });

  it("due today +40: date-only, or a timed deadline that has not passed (also at the exact minute)", () => {
    expect(urgency("2026-11-10")).toMatchObject({ urgency: 40, urgencyLevel: "TODAY" });
    expect(urgency("2026-11-10", "14:30")).toMatchObject({ urgency: 40, urgencyLevel: "TODAY" }); // overdue only once passed
    expect(urgency("2026-11-10", "18:00")).toMatchObject({ urgency: 40, urgencyLevel: "TODAY" });
    expect(urgency("2026-11-10", "23:59")).toMatchObject({ urgency: 40, urgencyLevel: "TODAY" });
  });

  it("due tomorrow +25, in 2-3 calendar days +15, later +0", () => {
    expect(urgency("2026-11-11")).toMatchObject({ urgency: 25, urgencyLevel: "TOMORROW" });
    expect(urgency("2026-11-11", "00:00")).toMatchObject({ urgency: 25, urgencyLevel: "TOMORROW" });
    expect(urgency("2026-11-12")).toMatchObject({ urgency: 15, urgencyLevel: "SOON" });
    expect(urgency("2026-11-13")).toMatchObject({ urgency: 15, urgencyLevel: "SOON" });
    expect(urgency("2026-11-14")).toMatchObject({ urgency: 0, urgencyLevel: "LATER" });
    expect(urgency("2026-11-17")).toMatchObject({ urgency: 0, urgencyLevel: "LATER" });
    expect(urgency("2030-01-01")).toMatchObject({ urgency: 0, urgencyLevel: "LATER" });
  });

  it("the time of a future deadline does not change the day it counts for", () => {
    for (const time of [null, "00:00", "12:00", "23:59"]) {
      expect(urgency("2026-11-12", time).urgencyLevel, String(time)).toBe("SOON");
    }
  });

  it("is the same 'overdue' the dashboard uses, for every unfinished status", () => {
    for (const status of ["TODO", "IN_PROGRESS", "POSTPONED"] as const) {
      expect(score({ status, deadlineDate: "2026-11-09" }).breakdown.urgencyLevel).toBe("OVERDUE");
    }
  });

  it("crosses month and year ends in calendar days", () => {
    const newYearsEve = new Date("2026-12-31T20:00:00Z"); // 22:00 on 31 Dec in Tallinn
    expect(scoreTask(task({ deadlineDate: "2027-01-01" }), { now: newYearsEve }).breakdown.urgencyLevel).toBe("TOMORROW");
    expect(scoreTask(task({ deadlineDate: "2027-01-03" }), { now: newYearsEve }).breakdown.urgencyLevel).toBe("SOON");
    expect(scoreTask(task({ deadlineDate: "2027-01-04" }), { now: newYearsEve }).breakdown.urgencyLevel).toBe("LATER");
    expect(scoreTask(task({ deadlineDate: "2028-03-01" }), { now: new Date("2028-02-27T10:00:00Z") }).breakdown.urgencyLevel).toBe("SOON"); // leap year: 29 Feb is in between
  });
});

describe("age bonus (only for tasks without a due date)", () => {
  const age = (days: number) => score({ createdAt: createdDaysAgo(days) }).breakdown;

  it("under 7 days +0, 7-13 +5, 14-29 +10, 30-59 +15, 60 or more +20 (every boundary)", () => {
    const expected: Array<[number, number]> = [[0, 0], [1, 0], [6, 0], [7, 5], [13, 5], [14, 10], [29, 10], [30, 15], [59, 15], [60, 20], [61, 20], [365, 20], [3650, 20]];
    for (const [days, points] of expected) expect(age(days).age, `${days} days`).toBe(points);
  });

  it("reports the age in calendar days (and none for a task with a due date)", () => {
    expect(age(10).ageDays).toBe(10);
    expect(score({ deadlineDate: "2026-12-30", createdAt: createdDaysAgo(100) }).breakdown).toMatchObject({ age: 0, ageDays: null, urgencyLevel: "LATER" });
  });

  it("does NOT apply to a task that has a due date, however old it is (overdue, today, tomorrow, soon, later)", () => {
    for (const deadlineDate of ["2026-11-01", "2026-11-10", "2026-11-11", "2026-11-13", "2027-06-01"]) {
      expect(score({ deadlineDate, createdAt: createdDaysAgo(200) }).breakdown.age, deadlineDate).toBe(0);
    }
  });

  it("counts calendar days since creation in the user's time zone: the creation midnight is exact", () => {
    // Created at 23:59:59 on 3 Nov (Tallinn) is 7 calendar days before the 10th; one second later it is the 4th.
    expect(score({ createdAt: "2026-11-03T21:59:59.000Z" }).breakdown.age).toBe(5);
    expect(score({ createdAt: "2026-11-03T22:00:00.000Z" }).breakdown.age).toBe(0);
  });

  it("a creation moment just before UTC midnight can already be the next day in Tallinn", () => {
    // 22:30 UTC on the 3rd is 00:30 on the 4th in Tallinn (6 days), while the UTC date would say 7.
    expect(score({ createdAt: "2026-11-03T22:30:00.000Z" }).breakdown.ageDays).toBe(6);
  });

  it("is never negative (a creation time in the future counts as age 0) and survives an unreadable timestamp", () => {
    expect(score({ createdAt: "2027-01-01T00:00:00.000Z" }).breakdown).toMatchObject({ age: 0, ageDays: 0 });
    expect(score({ createdAt: "not a date" }).breakdown).toMatchObject({ age: 0, ageDays: 0 });
  });

  it("ageBonus and ageInDays work on their own", () => {
    expect(ageBonus(6)).toBe(0);
    expect(ageBonus(7)).toBe(5);
    expect(ageInDays("2026-11-01T10:00:00.000Z", { date: "2026-11-10", time: "14:30" }, "Europe/Tallinn")).toBe(9);
  });
});

describe("clock changes (Europe/Tallinn: 29 Mar 2026 is 23 hours long, 25 Oct 2026 is 25 hours long)", () => {
  const level = (deadlineDate: string, at: string) => scoreTask(task({ deadlineDate }), { now: new Date(at), timeZone: "Europe/Tallinn" }).breakdown.urgencyLevel;

  it("spring: the last second of 28 March and the first second of 29 March", () => {
    expect(level("2026-03-29", "2026-03-28T21:59:59Z")).toBe("TOMORROW"); // 23:59:59 EET on the 28th
    expect(level("2026-03-28", "2026-03-28T21:59:59Z")).toBe("TODAY");
    expect(level("2026-03-29", "2026-03-28T22:00:00Z")).toBe("TODAY"); // 00:00 EET on the 29th
    expect(level("2026-03-28", "2026-03-28T22:00:00Z")).toBe("OVERDUE");
  });

  it("spring: the 23-hour day ends at its own midnight, not 24 hours after it began", () => {
    expect(level("2026-03-30", "2026-03-29T20:59:59Z")).toBe("TOMORROW"); // 23:59:59 EEST on the 29th
    expect(level("2026-03-29", "2026-03-29T20:59:59Z")).toBe("TODAY");
    expect(level("2026-03-30", "2026-03-29T21:00:00Z")).toBe("TODAY"); // 00:00 EEST on the 30th
    expect(level("2026-03-29", "2026-03-29T21:00:00Z")).toBe("OVERDUE");
    expect(level("2026-03-31", "2026-03-29T21:00:00Z")).toBe("TOMORROW");
    expect(level("2026-04-01", "2026-03-29T21:00:00Z")).toBe("SOON");
    expect(level("2026-04-02", "2026-03-29T21:00:00Z")).toBe("SOON");
    expect(level("2026-04-03", "2026-03-29T21:00:00Z")).toBe("LATER");
  });

  it("autumn: the last second of 24 October and the first second of 25 October", () => {
    expect(level("2026-10-25", "2026-10-24T20:59:59Z")).toBe("TOMORROW"); // 23:59:59 EEST on the 24th
    expect(level("2026-10-25", "2026-10-24T21:00:00Z")).toBe("TODAY"); // 00:00 EEST on the 25th
    expect(level("2026-10-24", "2026-10-24T21:00:00Z")).toBe("OVERDUE");
  });

  it("autumn: the 25-hour day stays one calendar day all the way to its own midnight", () => {
    expect(level("2026-10-26", "2026-10-25T10:00:00Z")).toBe("TOMORROW"); // midday
    expect(level("2026-10-25", "2026-10-25T21:59:59Z")).toBe("TODAY"); // 23:59:59 EET: the 25th lasted 25 hours
    expect(level("2026-10-26", "2026-10-25T21:59:59Z")).toBe("TOMORROW");
    expect(level("2026-10-26", "2026-10-25T22:00:00Z")).toBe("TODAY"); // 00:00 EET on the 26th
    expect(level("2026-10-25", "2026-10-25T22:00:00Z")).toBe("OVERDUE");
  });

  it("age is counted in calendar days across a clock change, not in 24-hour blocks", () => {
    const ageAt = (createdAt: string, at: string) => scoreTask(task({ createdAt }), { now: new Date(at), timeZone: "Europe/Tallinn" }).breakdown;
    // Spring: 7 calendar days but only 167 hours -> still 7 days (+5).
    expect(ageAt("2026-03-26T08:00:00Z", "2026-04-02T08:00:00Z")).toMatchObject({ ageDays: 7, age: 5 });
    // Autumn: 7 calendar days and 169 hours -> 7 days (+5), not "7 days and an hour".
    expect(ageAt("2026-10-24T12:00:00Z", "2026-10-31T12:00:00Z")).toMatchObject({ ageDays: 7, age: 5 });
    // The 14-day boundary falls exactly at local midnight after the spring change.
    expect(ageAt("2026-03-22T22:00:00Z", "2026-04-05T20:59:59Z")).toMatchObject({ ageDays: 13, age: 5 });
    expect(ageAt("2026-03-22T22:00:00Z", "2026-04-05T21:00:00Z")).toMatchObject({ ageDays: 14, age: 10 });
    // The 30-day boundary falls exactly at local midnight after the autumn change.
    expect(ageAt("2026-10-18T21:00:00Z", "2026-11-17T21:59:59Z")).toMatchObject({ ageDays: 29, age: 10 });
    expect(ageAt("2026-10-18T21:00:00Z", "2026-11-17T22:00:00Z")).toMatchObject({ ageDays: 30, age: 15 });
  });
});

describe("the time zone", () => {
  const at = new Date("2026-11-10T22:30:00Z"); // 00:30 on the 11th in Tallinn, 22:30 on the 10th in UTC, 17:30 on the 10th in New York
  const level = (timeZone?: string) => scoreTask(task({ deadlineDate: "2026-11-11" }), { now: at, timeZone }).breakdown.urgencyLevel;

  it("the same moment is a different day in a different zone", () => {
    expect(level("Europe/Tallinn")).toBe("TODAY");
    expect(level("UTC")).toBe("TOMORROW");
    expect(level("America/New_York")).toBe("TOMORROW");
    expect(level("Pacific/Auckland")).toBe("TODAY"); // 11:30 on the 11th there
    expect(level("Pacific/Honolulu")).toBe("TOMORROW"); // 12:30 on the 10th there
    expect(scoreTask(task({ deadlineDate: "2026-11-10" }), { now: at, timeZone: "Pacific/Auckland" }).breakdown.urgencyLevel).toBe("OVERDUE"); // the 10th is over in Auckland
  });

  it("defaults to Europe/Tallinn, and an unknown zone falls back to it", () => {
    expect(level(undefined)).toBe("TODAY");
    expect(level("Mars/Phobos")).toBe("TODAY");
    expect(scoreTask(task({ createdAt: createdDaysAgo(10) }), { now: NOW }).score).toBe(scoreTask(task({ createdAt: createdDaysAgo(10) }), { now: NOW, timeZone: "Mars/Phobos" }).score);
  });
});

describe("which tasks are ranked", () => {
  it("finished, archived and trashed tasks are not eligible", () => {
    expect(isRankable({ status: "COMPLETED" })).toBe(false);
    expect(isRankable({ status: "TODO", archivedAt: "2026-11-01T10:00:00.000Z" })).toBe(false);
    expect(isRankable({ status: "TODO", deletedAt: "2026-11-01T10:00:00.000Z" })).toBe(false);
    expect(isRankable({ status: "TODO", archivedAt: null, deletedAt: null })).toBe(true);
    expect(isRankable({ status: "TODO" })).toBe(true);
  });

  it("every unfinished status is eligible", () => {
    for (const status of ["TODO", "IN_PROGRESS", "POSTPONED"] as const) expect(isRankable({ status }), status).toBe(true);
  });

  it("rankTasks leaves the others out, silently and regardless of how good their score would be", () => {
    const keep = task({ priority: "LOW" });
    const ranked = rankTasks(
      [
        task({ status: "COMPLETED", priority: "HIGH", deadlineDate: "2026-11-01" }),
        task({ archivedAt: "2026-11-02T10:00:00.000Z", priority: "HIGH", deadlineDate: "2026-11-01" }),
        task({ deletedAt: "2026-11-02T10:00:00.000Z", priority: "HIGH", deadlineDate: "2026-11-01" }),
        keep,
      ],
      ctx,
    );
    expect(ranked.map((r) => r.task.id)).toEqual([keep.id]);
  });

  it("an empty list, or a list with nothing eligible, gives an empty ranking", () => {
    expect(rankTasks([], ctx)).toEqual([]);
    expect(rankTasks([task({ status: "COMPLETED" })], ctx)).toEqual([]);
  });
});

describe("the order", () => {
  it("higher score first (a worked example with every kind of task)", () => {
    const a = task({ id: "A", priority: "HIGH", deadlineDate: "2026-11-09" }); // 50 + 60 = 110
    const b = task({ id: "B", priority: "MEDIUM", deadlineDate: "2026-11-09" }); // 25 + 60 = 85
    const c = task({ id: "C", priority: "HIGH", deadlineDate: "2026-11-10" }); // 50 + 40 = 90
    const d = task({ id: "D", priority: "LOW", deadlineDate: "2026-11-09" }); // 0 + 60 = 60
    const e = task({ id: "E", priority: "HIGH" }); // 50 (no due date, new)
    const f = task({ id: "F", priority: "MEDIUM", deadlineDate: "2026-11-11" }); // 25 + 25 = 50
    const g = task({ id: "G", priority: "LOW", createdAt: createdDaysAgo(60) }); // 0 + 20 = 20
    const ranked = rankTasks([g, e, d, f, b, c, a], ctx);
    expect(ranked.map((r) => [r.task.id, r.score, r.rank])).toEqual([["A", 110, 1], ["C", 90, 2], ["B", 85, 3], ["D", 60, 4], ["F", 50, 5], ["E", 50, 6], ["G", 20, 7]]);
  });

  it("priority alone cannot beat a big urgency gap, and age alone cannot beat priority", () => {
    const overdueLow = task({ id: "overdue-low", priority: "LOW", deadlineDate: "2026-11-09" }); // 60
    const highNoDue = task({ id: "high-no-due", priority: "HIGH" }); // 50
    const mediumOldNoDue = task({ id: "medium-old", priority: "MEDIUM", createdAt: createdDaysAgo(90) }); // 45
    const lowOldNoDue = task({ id: "low-old", priority: "LOW", createdAt: createdDaysAgo(90) }); // 20
    expect(rankTasks([lowOldNoDue, mediumOldNoDue, highNoDue, overdueLow], ctx).map((r) => r.task.id)).toEqual(["overdue-low", "high-no-due", "medium-old", "low-old"]);
  });

  describe("ties", () => {
    it("same score: the earlier due date first (even against a higher priority)", () => {
      const mediumToday = task({ id: "medium-today", priority: "MEDIUM", deadlineDate: "2026-11-10", deadlineTime: "18:00" }); // 25 + 40 = 65
      const highSoon = task({ id: "high-soon", priority: "HIGH", deadlineDate: "2026-11-13" }); // 50 + 15 = 65
      const ranked = rankTasks([highSoon, mediumToday], ctx);
      expect(ranked.map((r) => r.score)).toEqual([65, 65]);
      expect(ranked.map((r) => r.task.id)).toEqual(["medium-today", "high-soon"]);
    });

    it("same score: a task without a due date comes after every task with one", () => {
      const noDue = task({ id: "no-due", priority: "HIGH" }); // 50
      const dated = task({ id: "dated", priority: "MEDIUM", deadlineDate: "2026-11-11" }); // 50
      expect(rankTasks([noDue, dated], ctx).map((r) => r.task.id)).toEqual(["dated", "no-due"]);
      expect(rankTasks([dated, noDue], ctx).map((r) => r.task.id)).toEqual(["dated", "no-due"]);
    });

    it("same score and same priority: the earlier due date and time first (a timed deadline before a date-only one on the same day)", () => {
      const early = task({ id: "z-early", priority: "MEDIUM", deadlineDate: "2026-11-08" });
      const late = task({ id: "a-late", priority: "MEDIUM", deadlineDate: "2026-11-09" });
      expect(rankTasks([late, early], ctx).map((r) => r.task.id)).toEqual(["z-early", "a-late"]); // both overdue: 85
      const timed = task({ id: "timed", priority: "MEDIUM", deadlineDate: "2026-11-10", deadlineTime: "16:00" });
      const dateOnly = task({ id: "date-only", priority: "MEDIUM", deadlineDate: "2026-11-10" });
      expect(rankTasks([dateOnly, timed], ctx).map((r) => r.task.id)).toEqual(["timed", "date-only"]);
    });

    it("same score, same due date: the older task first, then the task id", () => {
      const oldNoDue = task({ id: "b", priority: "MEDIUM", createdAt: createdDaysAgo(10) }); // both +5
      const olderNoDue = task({ id: "c", priority: "MEDIUM", createdAt: createdDaysAgo(12) });
      expect(rankTasks([oldNoDue, olderNoDue], ctx).map((r) => r.task.id)).toEqual(["c", "b"]);
      const sameTime = createdDaysAgo(10);
      const first = task({ id: "id-a", priority: "MEDIUM", createdAt: sameTime });
      const second = task({ id: "id-b", priority: "MEDIUM", createdAt: sameTime });
      expect(rankTasks([second, first], ctx).map((r) => r.task.id)).toEqual(["id-a", "id-b"]);
    });

    it("the tie-breakers in order, each tested directly on equal scores (priority, then creation time, then id)", () => {
      const scored = (o: Partial<RankableTask>): ScoredTask => ({ task: task(o), score: 40, breakdown: { priority: 0, urgency: 0, urgencyLevel: "NONE", age: 0, ageDays: 0 } });
      // 3. the higher priority first
      expect(compareScored(scored({ priority: "HIGH", id: "b" }), scored({ priority: "LOW", id: "a" }))).toBeLessThan(0);
      expect(compareScored(scored({ priority: "MEDIUM", id: "b" }), scored({ priority: "HIGH", id: "a" }))).toBeGreaterThan(0);
      expect(compareScored(scored({ priority: "LOW", id: "b" }), scored({ priority: "MEDIUM", id: "a" }))).toBeGreaterThan(0);
      // 4. the older task first (priority equal)
      expect(compareScored(scored({ createdAt: "2026-01-01T00:00:00.000Z", id: "b" }), scored({ createdAt: "2026-02-01T00:00:00.000Z", id: "a" }))).toBeLessThan(0);
      expect(compareScored(scored({ createdAt: "2026-02-01T00:00:00.000Z" }), scored({ createdAt: "2026-01-01T00:00:00.000Z" }))).toBeGreaterThan(0);
      // 5. the id (everything else equal)
      expect(compareScored(scored({ id: "a" }), scored({ id: "b" }))).toBeLessThan(0);
      expect(compareScored(scored({ id: "b" }), scored({ id: "a" }))).toBeGreaterThan(0);
      // a priority difference wins over age and id; a due date wins over priority
      expect(compareScored(scored({ priority: "HIGH", createdAt: "2026-06-01T00:00:00.000Z", id: "z" }), scored({ priority: "LOW", createdAt: "2026-01-01T00:00:00.000Z", id: "a" }))).toBeLessThan(0);
      expect(compareScored(scored({ priority: "LOW", deadlineDate: "2026-11-11" }), scored({ priority: "HIGH" }))).toBeLessThan(0);
      // the same task compares equal to itself
      const same = scored({ id: "x" });
      expect(compareScored(same, same)).toBe(0);
    });

    it("a higher score always wins over every tie-breaker", () => {
      const scored = (score: number, o: Partial<RankableTask>): ScoredTask => ({ task: task(o), score, breakdown: { priority: 0, urgency: 0, urgencyLevel: "NONE", age: 0, ageDays: 0 } });
      expect(compareScored(scored(51, { priority: "LOW", id: "z", createdAt: "2026-11-09T00:00:00.000Z" }), scored(50, { priority: "HIGH", id: "a", createdAt: "2020-01-01T00:00:00.000Z", deadlineDate: "2026-01-01" }))).toBeLessThan(0);
    });
  });

  it("rank numbers are 1..n, strictly increasing, in the order of the list", () => {
    const ranked = rankTasks(Array.from({ length: 12 }, (_, i) => task({ priority: (["HIGH", "MEDIUM", "LOW"] as const)[i % 3], deadlineDate: i % 4 === 0 ? null : `2026-11-${String(5 + i).padStart(2, "0")}` })), ctx);
    expect(ranked.map((r) => r.rank)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
  });
});

describe("determinism", () => {
  // A small seeded random generator, so the shuffles are the same on every run.
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const priorities = ["HIGH", "MEDIUM", "LOW"] as const;
  const build = (n: number) => {
    const random = mulberry32(7);
    return Array.from({ length: n }, (_, i): RankableTask => ({
      id: `task-${String(i).padStart(3, "0")}`,
      status: (["TODO", "IN_PROGRESS", "POSTPONED", "COMPLETED"] as const)[Math.floor(random() * 4)],
      priority: priorities[Math.floor(random() * 3)],
      createdAt: new Date(Date.UTC(2026, 5, 1) + Math.floor(random() * 160) * 86_400_000 + Math.floor(random() * 4) * 3_600_000).toISOString(),
      deadlineDate: random() < 0.35 ? null : `2026-11-${String(1 + Math.floor(random() * 20)).padStart(2, "0")}`,
      deadlineTime: random() < 0.4 ? `${String(Math.floor(random() * 24)).padStart(2, "0")}:${random() < 0.5 ? "00" : "30"}` : null,
      archivedAt: random() < 0.1 ? "2026-11-01T00:00:00.000Z" : null,
    })).map((t) => (t.deadlineDate === null ? { ...t, deadlineTime: null } : t));
  };

  it("the same tasks in any input order give exactly the same ranking", () => {
    const tasks = build(80);
    const baseline = rankTasks(tasks, ctx).map((r) => r.task.id);
    expect(baseline.length).toBeGreaterThan(30);
    const random = mulberry32(99);
    for (let round = 0; round < 100; round++) {
      const shuffled = [...tasks];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(rankTasks(shuffled, ctx).map((r) => r.task.id), `shuffle ${round}`).toEqual(baseline);
    }
  });

  it("does not change its input (frozen tasks and a frozen list are fine) and returns new objects", () => {
    const tasks = Object.freeze(build(30).map((t) => Object.freeze(t)));
    const before = JSON.stringify(tasks);
    const ranked = rankTasks(tasks, ctx);
    expect(JSON.stringify(tasks)).toBe(before);
    expect(ranked.every((r) => tasks.includes(r.task))).toBe(true); // the tasks themselves are passed through unchanged
    const now = new Date(NOW);
    rankTasks(tasks, { now, timeZone: "Europe/Tallinn" });
    expect(now.getTime()).toBe(NOW.getTime());
  });

  it("running it twice gives identical results, including every breakdown", () => {
    const tasks = build(50);
    expect(JSON.stringify(rankTasks(tasks, ctx))).toBe(JSON.stringify(rankTasks(tasks, ctx)));
  });

  it("the comparison is a consistent total order: antisymmetric, and it never says two different tasks are equal", () => {
    const scored = build(60).filter(isRankable).map((t) => scoreTask(t, ctx));
    for (const a of scored) {
      for (const b of scored) {
        if (a === b) continue;
        const ab = compareScored(a, b);
        expect(Math.sign(ab)).toBe(-Math.sign(compareScored(b, a)));
        expect(ab).not.toBe(0);
      }
    }
  });

  it("the ranking depends on the moment only through the day and minute: a later minute of the same day keeps the order of dated tasks", () => {
    const tasks = [task({ id: "a", priority: "HIGH", deadlineDate: "2026-11-11" }), task({ id: "b", priority: "LOW", deadlineDate: "2026-11-10" }), task({ id: "c", priority: "MEDIUM" })];
    const morning = rankTasks(tasks, { now: new Date("2026-11-10T06:00:00Z") }).map((r) => r.task.id);
    const evening = rankTasks(tasks, { now: new Date("2026-11-10T19:00:00Z") }).map((r) => r.task.id);
    expect(evening).toEqual(morning);
  });
});

describe("urgencyLevel on its own", () => {
  it("none for a task without a due date, whatever its status", () => {
    expect(urgencyLevel({ status: "TODO", deadlineDate: null, deadlineTime: null }, { date: "2026-11-10", time: "14:30" })).toBe("NONE");
  });
});
