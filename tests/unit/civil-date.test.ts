import { describe, expect, it } from "vitest";

import { addDays, clampDayToMonth, daysInMonth, diffDays, isLeapYear, isoWeekday } from "@/lib/recurrence/civil-date";

describe("civil-date", () => {
  it("agrees with JavaScript's UTC calendar for every day from 2000 to 2100", () => {
    // The oracle only reads UTC calendar fields, so no time zone is involved.
    for (let i = 0; i <= 36_890; i++) {
      const oracle = new Date(Date.UTC(2000, 0, 1 + i));
      const iso = oracle.toISOString().slice(0, 10);
      expect(addDays("2000-01-01", i)).toBe(iso);
      expect(isoWeekday(iso)).toBe(oracle.getUTCDay() === 0 ? 7 : oracle.getUTCDay());
      expect(diffDays(iso, "2000-01-01")).toBe(i);
    }
  });

  it.each([
    ["2026-02-28", 1, "2026-03-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2028-02-28", 2, "2028-03-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-01-01", -1, "2026-12-31"],
    ["2026-03-01", 365, "2027-03-01"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-03-29", 0, "2026-03-29"],
    ["2026-10-24", 1, "2026-10-25"],
  ])("addDays(%s, %i) = %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it("knows the ISO weekday of dates used elsewhere in the tests", () => {
    expect(isoWeekday("2026-11-02")).toBe(1); // Monday
    expect(isoWeekday("2026-11-08")).toBe(7); // Sunday
    expect(isoWeekday("2026-10-29")).toBe(4); // Thursday
    expect(isoWeekday("2026-03-29")).toBe(7); // Sunday: Tallinn spring DST change
    expect(isoWeekday("2026-10-25")).toBe(7); // Sunday: Tallinn autumn DST change
    expect(isoWeekday("2028-02-29")).toBe(2); // Tuesday
    expect(isoWeekday("1970-01-01")).toBe(4);
  });

  it("handles leap years and month lengths", () => {
    expect([2000, 2024, 2028].every(isLeapYear)).toBe(true);
    expect([1900, 2026, 2027, 2100].some(isLeapYear)).toBe(false);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect([1, 3, 5, 7, 8, 10, 12].map((m) => daysInMonth(2026, m))).toEqual([31, 31, 31, 31, 31, 31, 31]);
    expect([4, 6, 9, 11].map((m) => daysInMonth(2026, m))).toEqual([30, 30, 30, 30]);
  });

  it("clamps a target day to the last day of a shorter month", () => {
    expect(clampDayToMonth(2026, 2, 31)).toBe("2026-02-28");
    expect(clampDayToMonth(2028, 2, 31)).toBe("2028-02-29");
    expect(clampDayToMonth(2026, 4, 31)).toBe("2026-04-30");
    expect(clampDayToMonth(2026, 3, 31)).toBe("2026-03-31");
    expect(clampDayToMonth(2026, 2, 15)).toBe("2026-02-15");
  });
});
