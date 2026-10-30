import { describe, expect, it } from "vitest";

import { localDayRange, todayRange } from "@/lib/dashboard/day";
import { firstName, greetingFor, greetingLine } from "@/lib/dashboard/greeting";
import { MAX_POSTPONE_DAYS, nextMonday, postponeOptions, postponeProblem, presetDate } from "@/lib/postpone-rules";

const TZ = "Europe/Tallinn";

describe("greeting", () => {
  it("changes exactly at 05:00, 12:00, 18:00 and 22:00", () => {
    expect(greetingFor(4)).toBe("Good night");
    expect(greetingFor(5)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(17)).toBe("Good afternoon");
    expect(greetingFor(18)).toBe("Good evening");
    expect(greetingFor(21)).toBe("Good evening");
    expect(greetingFor(22)).toBe("Good night");
    expect(greetingFor(0)).toBe("Good night");
  });

  it("uses the first name when there is one", () => {
    expect(greetingLine("09:15", "Edvin Pasun")).toBe("Good morning, Edvin");
    expect(greetingLine("13:00", "  Anna  ")).toBe("Good afternoon, Anna");
    expect(greetingLine("19:00", "")).toBe("Good evening");
    expect(greetingLine("19:00", null)).toBe("Good evening");
    expect(firstName("x".repeat(100))).toHaveLength(40);
  });
});

describe("local day boundaries", () => {
  it("a normal Tallinn day is 24 hours: midnight to midnight local", () => {
    const { start, end } = localDayRange("2026-11-10", TZ);
    expect(start.toISOString()).toBe("2026-11-09T22:00:00.000Z"); // 00:00 EET
    expect(end.toISOString()).toBe("2026-11-10T22:00:00.000Z");
  });

  it("the day the clocks go forward (2026-03-29) is 23 hours", () => {
    const { start, end } = localDayRange("2026-03-29", TZ);
    expect(start.toISOString()).toBe("2026-03-28T22:00:00.000Z"); // 00:00 EET
    expect(end.toISOString()).toBe("2026-03-29T21:00:00.000Z"); // 00:00 EEST
    expect((end.getTime() - start.getTime()) / 3600000).toBe(23);
  });

  it("the day the clocks go back (2026-10-25) is 25 hours", () => {
    const { start, end } = localDayRange("2026-10-25", TZ);
    expect(start.toISOString()).toBe("2026-10-24T21:00:00.000Z"); // 00:00 EEST
    expect(end.toISOString()).toBe("2026-10-25T22:00:00.000Z"); // 00:00 EET
    expect((end.getTime() - start.getTime()) / 3600000).toBe(25);
  });

  it("consecutive days share their boundary, so a moment is in exactly one day", () => {
    for (const date of ["2026-03-28", "2026-03-29", "2026-10-24", "2026-10-25", "2026-12-31"]) {
      const today = localDayRange(date, TZ);
      const next = localDayRange(new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10), TZ);
      expect(today.end.getTime()).toBe(next.start.getTime());
    }
  });

  it("works for other saved time zones too", () => {
    const { start, end } = localDayRange("2026-07-01", "America/New_York");
    expect(start.toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-02T04:00:00.000Z");
  });

  it("todayRange uses the user's local date, which can differ from the UTC date", () => {
    // 22:30 UTC on the 9th is already the 10th in Tallinn.
    const result = todayRange(new Date("2026-11-09T22:30:00Z"), TZ);
    expect(result.local.date).toBe("2026-11-10");
    expect(result.start.toISOString()).toBe("2026-11-09T22:00:00.000Z");
    expect(todayRange(new Date("2026-11-09T21:59:59Z"), TZ).local.date).toBe("2026-11-09");
  });
});

describe("postpone dates", () => {
  // 2026-11-09 is a Monday ... 2026-11-15 a Sunday.
  it("tomorrow and in 3 days are calendar days from today", () => {
    expect(presetDate("tomorrow", "2026-11-10")).toBe("2026-11-11");
    expect(presetDate("in3days", "2026-11-10")).toBe("2026-11-13");
    expect(presetDate("tomorrow", "2026-12-31")).toBe("2027-01-01");
    expect(presetDate("in3days", "2028-02-27")).toBe("2028-03-01"); // leap year
  });

  it("next week is the next Monday, for every weekday", () => {
    expect(nextMonday("2026-11-09")).toBe("2026-11-16"); // Monday -> a week later
    expect(nextMonday("2026-11-10")).toBe("2026-11-16"); // Tuesday
    expect(nextMonday("2026-11-13")).toBe("2026-11-16"); // Friday
    expect(nextMonday("2026-11-14")).toBe("2026-11-16"); // Saturday
    expect(nextMonday("2026-11-15")).toBe("2026-11-16"); // Sunday
    expect(nextMonday("2026-12-30")).toBe("2027-01-04");
  });

  it("refuses dates that are not in the future or not later than the deadline", () => {
    const today = "2026-11-10";
    expect(postponeProblem("2026-11-11", today, "2026-11-09")).toBeNull(); // an overdue task, to tomorrow
    expect(postponeProblem("2026-11-11", today, "2026-11-10")).toBeNull();
    expect(postponeProblem("2026-11-10", today, "2026-11-09")).toBe("NOT_FUTURE"); // today is not the future
    expect(postponeProblem("2026-11-09", today, "2026-11-01")).toBe("NOT_FUTURE");
    expect(postponeProblem("2026-11-12", today, "2026-11-12")).toBe("NOT_LATER"); // the same day
    expect(postponeProblem("2026-11-12", today, "2026-11-15")).toBe("NOT_LATER"); // earlier than the deadline
    expect(postponeProblem("nonsense", today, "2026-11-09")).toBe("INVALID_DATE");
    expect(postponeProblem("2026-02-30", today, "2026-11-09")).toBe("INVALID_DATE");
    expect(postponeProblem("", today, "2026-11-09")).toBe("INVALID_DATE");
    expect(postponeProblem("2050-01-01", today, "2026-11-09")).toBe("TOO_FAR");
    expect(MAX_POSTPONE_DAYS).toBeGreaterThan(300);
  });

  it("offers only the presets that really move the deadline later", () => {
    const today = "2026-11-10"; // Tuesday; next Monday is 11-16
    expect(postponeOptions(today, "2026-11-09").options.map((o) => o.choice)).toEqual(["tomorrow", "in3days", "nextWeek"]);
    expect(postponeOptions(today, "2026-11-11").options.map((o) => o.choice)).toEqual(["in3days", "nextWeek"]);
    expect(postponeOptions(today, "2026-11-13").options.map((o) => o.choice)).toEqual(["nextWeek"]);
    expect(postponeOptions(today, "2026-11-16").options).toEqual([]);
    expect(postponeOptions(today, "2026-11-09").earliest).toBe("2026-11-11");
    expect(postponeOptions(today, "2026-11-14").earliest).toBe("2026-11-15");
  });
});
