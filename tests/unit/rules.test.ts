import { describe, expect, it } from "vitest";

import {
  buildOccurrence,
  compareOccurrenceKeys,
  isOccurrenceKey,
  nextOccurrenceAfter,
  normalizeWeekdays,
  occurrencesAfter,
  occursOn,
  parseOccurrenceKey,
  referencePoint,
  ruleFromAnchor,
  validateRule,
  type Point,
  type RuleConfig,
} from "@/lib/recurrence/rules";

// 2026 calendar used below: Mon 2 Nov, Mon 9 Nov, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov, Mon 7 Dec …
// Sun 29 Mar and Sun 25 Oct are Tallinn's daylight-saving days.
const date = (value: string): Point => ({ date: value, time: null });
const at = (value: string, time: string): Point => ({ date: value, time });
const next = (rule: RuleConfig, reference: Point) => nextOccurrenceAfter(rule, reference)?.key ?? null;
const freeze = <T extends object>(value: T): T => Object.freeze(value);

const daily = (anchorDate = "2026-11-02", extra: Partial<RuleConfig> = {}) => ruleFromAnchor("DAILY", anchorDate, extra);
const weekly = (anchorDate = "2026-11-02", extra: Partial<RuleConfig> = {}) => ruleFromAnchor("WEEKLY", anchorDate, extra);
const monthly = (anchorDate: string, extra: Partial<RuleConfig> = {}) => ruleFromAnchor("MONTHLY", anchorDate, extra);
const custom = (weekdays: number[], anchorDate: string, extra: Partial<RuleConfig> = {}) => ruleFromAnchor("CUSTOM_WEEKDAYS", anchorDate, { weekdays, ...extra });

describe("daily", () => {
  const rule = freeze(daily());
  it("repeats every calendar day, always strictly after the reference", () => {
    expect(next(rule, date("2026-11-05"))).toBe("2026-11-06");
    expect(next(rule, date("2026-11-02"))).toBe("2026-11-03");
  });
  it("crosses month, year and leap-day boundaries", () => {
    expect(next(rule, date("2026-11-30"))).toBe("2026-12-01");
    expect(next(rule, date("2026-12-31"))).toBe("2027-01-01");
    expect(next(rule, date("2028-02-28"))).toBe("2028-02-29");
    expect(next(rule, date("2028-02-29"))).toBe("2028-03-01");
    expect(next(rule, date("2027-02-28"))).toBe("2027-03-01");
  });
  it("starts at the anchor when the reference is earlier", () => {
    expect(next(rule, date("2026-10-01"))).toBe("2026-11-02");
  });
});

describe("weekly", () => {
  const monday = freeze(weekly("2026-11-02"));
  it("keeps the original weekday", () => {
    expect(monday.weekdays).toEqual([1]);
    expect(next(monday, date("2026-11-02"))).toBe("2026-11-09");
    expect(next(monday, date("2026-11-05"))).toBe("2026-11-09"); // Thursday
    expect(next(monday, date("2026-11-08"))).toBe("2026-11-09"); // Sunday
    expect(next(monday, date("2026-11-09"))).toBe("2026-11-16"); // on the day itself: a later date
  });
  it("crosses the year boundary", () => {
    expect(next(monday, date("2026-12-28"))).toBe("2027-01-04");
  });
  it("works for Sunday (7)", () => {
    expect(next(weekly("2026-11-08"), date("2026-11-08"))).toBe("2026-11-15");
  });
});

describe("monthly", () => {
  it("uses the last day of shorter months but never changes the original day (Jan 31)", () => {
    const rule = freeze(monthly("2026-01-31"));
    expect(rule.monthlyDay).toBe(31);
    const keys = occurrencesAfter(rule, date("2026-01-31"), { limit: 13 }).map((o) => o.key);
    expect(keys).toEqual([
      "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
      "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28",
    ]);
  });
  it("uses Feb 29 in a leap year", () => {
    expect(next(monthly("2028-01-31"), date("2028-01-31"))).toBe("2028-02-29");
    expect(next(monthly("2028-01-31"), date("2028-02-29"))).toBe("2028-03-31");
  });
  it("handles day 30 and day 29 in February", () => {
    expect(next(monthly("2026-01-30"), date("2026-01-30"))).toBe("2026-02-28");
    expect(next(monthly("2026-01-30"), date("2026-02-28"))).toBe("2026-03-30");
    expect(next(monthly("2027-01-29"), date("2027-01-29"))).toBe("2027-02-28");
    expect(next(monthly("2028-01-29"), date("2028-01-29"))).toBe("2028-02-29");
  });
  it("handles ordinary days and year boundaries", () => {
    expect(next(monthly("2026-11-15"), date("2026-11-20"))).toBe("2026-12-15");
    expect(next(monthly("2026-12-15"), date("2026-12-15"))).toBe("2027-01-15");
    expect(next(monthly("2026-12-01"), date("2026-12-31"))).toBe("2027-01-01");
  });
  it("accepts an anchor on a clamped day (Feb 28 with target day 31)", () => {
    const rule = { ...monthly("2026-01-31"), anchorDate: "2026-02-28" };
    expect(validateRule(rule)).toEqual([]);
    expect(next(rule, date("2026-02-28"))).toBe("2026-03-31");
  });
});

describe("custom weekdays", () => {
  const mwf = freeze(custom([1, 3, 5], "2026-11-02"));
  it("returns the nearest eligible weekday after the reference", () => {
    expect(next(mwf, date("2026-11-02"))).toBe("2026-11-04"); // Mon → Wed
    expect(next(mwf, date("2026-11-04"))).toBe("2026-11-06"); // Wed → Fri
    expect(next(mwf, date("2026-11-06"))).toBe("2026-11-09"); // Fri → Mon
    expect(next(mwf, date("2026-11-07"))).toBe("2026-11-09"); // Sat → Mon
    expect(next(mwf, date("2026-11-08"))).toBe("2026-11-09"); // Sun → Mon
    expect(next(mwf, date("2026-11-03"))).toBe("2026-11-04"); // Tue → Wed
  });
  it("crosses a year boundary over a non-eligible Thursday", () => {
    expect(next(mwf, date("2026-12-30"))).toBe("2027-01-01"); // Wed → Fri (Thu 31 Dec is not eligible)
    expect(next(mwf, date("2027-01-01"))).toBe("2027-01-04");
  });
  it("supports a weekend-only and a single-weekday set", () => {
    const weekend = custom([6, 7], "2026-11-07");
    expect(next(weekend, date("2026-11-07"))).toBe("2026-11-08");
    expect(next(weekend, date("2026-11-08"))).toBe("2026-11-14");
    expect(next(custom([2], "2026-11-03"), date("2026-11-03"))).toBe("2026-11-10");
  });
  it("normalises weekday lists", () => {
    expect(normalizeWeekdays([5, 1, 3, 1])).toEqual([1, 3, 5]);
  });
});

describe("end date (inclusive)", () => {
  it("allows an occurrence on the end date and nothing after", () => {
    const rule = weekly("2026-11-02", { endDate: "2026-11-16" });
    expect(next(rule, date("2026-11-09"))).toBe("2026-11-16");
    expect(next(rule, date("2026-11-16"))).toBeNull();
    expect(next(weekly("2026-11-02", { endDate: "2026-11-15" }), date("2026-11-09"))).toBeNull();
    expect(next(daily("2026-11-02", { endDate: "2026-11-10" }), date("2026-11-09"))).toBe("2026-11-10");
    expect(next(daily("2026-11-02", { endDate: "2026-11-10" }), date("2026-11-10"))).toBeNull();
    expect(next(monthly("2026-01-31", { endDate: "2026-02-28" }), date("2026-01-31"))).toBe("2026-02-28");
    expect(next(monthly("2026-01-31", { endDate: "2026-02-28" }), date("2026-02-28"))).toBeNull();
  });
  it("for timed series, the end date's own occurrence time still counts", () => {
    const rule = daily("2026-11-02", { plannedTime: "09:00", endDate: "2026-11-10" });
    expect(next(rule, at("2026-11-10", "08:00"))).toBe("2026-11-10T09:00");
    expect(next(rule, at("2026-11-10", "09:00"))).toBeNull();
  });
});

describe("timed series", () => {
  const nineAm = freeze(daily("2026-11-02", { plannedTime: "09:00" }));
  it("allows a later time on the same day, but nothing at or before the reference instant", () => {
    expect(next(nineAm, at("2026-11-05", "08:00"))).toBe("2026-11-05T09:00");
    expect(next(nineAm, at("2026-11-05", "09:00"))).toBe("2026-11-06T09:00");
    expect(next(nineAm, at("2026-11-05", "09:01"))).toBe("2026-11-06T09:00");
    expect(next(nineAm, at("2026-11-05", "23:59"))).toBe("2026-11-06T09:00");
  });
  it("date-only series never pick the same day", () => {
    expect(next(daily(), date("2026-11-09"))).toBe("2026-11-10");
  });
  it("keeps the wall-clock key across both daylight-saving changes", () => {
    const rule = daily("2026-03-27", { plannedTime: "09:00" });
    expect(occurrencesAfter(rule, at("2026-03-27", "09:00"), { limit: 4 }).map((o) => o.key)).toEqual([
      "2026-03-28T09:00", "2026-03-29T09:00", "2026-03-30T09:00", "2026-03-31T09:00",
    ]);
  });
  it("spring: an occurrence at a nonexistent 03:30 is ordered as 04:30", () => {
    const rule = weekly("2026-03-22", { plannedTime: "03:30" });
    expect(next(rule, at("2026-03-22", "03:30"))).toBe("2026-03-29T03:30");
    expect(next(rule, at("2026-03-29", "04:29"))).toBe("2026-03-29T03:30"); // 04:30 is still ahead
    expect(next(rule, at("2026-03-29", "04:30"))).toBe("2026-04-05T03:30"); // same instant is not "after"
  });
  it("autumn: an ambiguous 03:30 happens once per day and means the first one", () => {
    const rule = daily("2026-10-24", { plannedTime: "03:30" });
    expect(next(rule, at("2026-10-24", "03:30"))).toBe("2026-10-25T03:30");
    expect(next(rule, at("2026-10-25", "03:30"))).toBe("2026-10-26T03:30");
    expect(next(rule, at("2026-10-25", "03:45"))).toBe("2026-10-26T03:30");
    expect(next(rule, at("2026-10-25", "02:59"))).toBe("2026-10-25T03:30");
  });
});

describe("reference point: the later of the completed occurrence and now", () => {
  it("date-only", () => {
    const rule = weekly();
    expect(referencePoint(rule, parseOccurrenceKey("2026-11-09"), { date: "2026-11-03", time: "10:00" })).toEqual(date("2026-11-09")); // early
    expect(referencePoint(rule, parseOccurrenceKey("2026-11-09"), { date: "2026-11-12", time: "08:00" })).toEqual(date("2026-11-12")); // late
    expect(referencePoint(rule, null, { date: "2026-11-12", time: "08:00" })).toEqual(date("2026-11-12"));
  });
  it("timed", () => {
    const rule = daily("2026-11-02", { plannedTime: "09:00" });
    expect(referencePoint(rule, parseOccurrenceKey("2026-11-09T09:00"), { date: "2026-11-09", time: "08:00" })).toEqual(at("2026-11-09", "09:00"));
    expect(referencePoint(rule, parseOccurrenceKey("2026-11-09T09:00"), { date: "2026-11-09", time: "10:00" })).toEqual(at("2026-11-09", "10:00"));
  });
});

describe("successor after completing an instance (fixed schedule)", () => {
  const successor = (rule: RuleConfig, completedKey: string, now: { date: string; time: string }) =>
    nextOccurrenceAfter(rule, referencePoint(rule, parseOccurrenceKey(completedKey), now))?.key ?? null;
  const monday = freeze(weekly("2026-11-02"));

  it("follows the original schedule, not the completion date", () => {
    expect(successor(monday, "2026-11-02", { date: "2026-11-05", time: "12:00" })).toBe("2026-11-09"); // done Thursday → next Monday, not +7 days
  });
  it("skips missed occurrences instead of queuing them", () => {
    expect(successor(monday, "2026-11-02", { date: "2026-11-25", time: "12:00" })).toBe("2026-11-30"); // 9, 16 and 23 Nov skipped
  });
  it("early completion moves forward and never repeats an occurrence", () => {
    expect(successor(monday, "2026-11-09", { date: "2026-11-03", time: "12:00" })).toBe("2026-11-16");
    expect(successor(monday, "2026-11-16", { date: "2026-11-03", time: "12:00" })).toBe("2026-11-23");
    expect(successor(monday, "2026-11-23", { date: "2026-11-03", time: "12:00" })).toBe("2026-11-30");
  });
  it("date-only: completing on the day of the next occurrence picks a LATER date", () => {
    expect(successor(monday, "2026-11-02", { date: "2026-11-08", time: "12:00" })).toBe("2026-11-09");
    expect(successor(monday, "2026-11-02", { date: "2026-11-09", time: "12:00" })).toBe("2026-11-16");
  });
  it("daily date-only", () => {
    const rule = daily();
    expect(successor(rule, "2026-11-08", { date: "2026-11-09", time: "12:00" })).toBe("2026-11-10");
    expect(successor(rule, "2026-11-09", { date: "2026-11-09", time: "12:00" })).toBe("2026-11-10");
  });
  it("timed: a same-day later occurrence may be chosen", () => {
    const rule = daily("2026-11-02", { plannedTime: "18:00" });
    expect(successor(rule, "2026-11-08T18:00", { date: "2026-11-09", time: "07:00" })).toBe("2026-11-09T18:00");
    expect(successor(rule, "2026-11-08T18:00", { date: "2026-11-09", time: "19:00" })).toBe("2026-11-10T18:00");
  });
  it("monthly keeps the original target day", () => {
    const rule = monthly("2026-01-31");
    expect(successor(rule, "2026-01-31", { date: "2026-02-05", time: "09:00" })).toBe("2026-02-28");
    expect(successor(rule, "2026-02-28", { date: "2026-02-28", time: "09:00" })).toBe("2026-03-31");
  });
  it("ends after the end date", () => {
    expect(successor(weekly("2026-11-02", { endDate: "2026-11-16" }), "2026-11-16", { date: "2026-11-10", time: "09:00" })).toBeNull();
  });
});

describe("occursOn / anchor", () => {
  it("never reports a date before the anchor", () => {
    expect(occursOn(daily("2026-11-02"), "2026-11-01")).toBe(false);
    expect(occursOn(daily("2026-11-02"), "2026-11-02")).toBe(true);
  });
});

describe("validateRule", () => {
  const codes = (rule: RuleConfig) => validateRule(rule).map((i) => `${i.field}:${i.code}`);

  it("accepts a well-formed rule of every type", () => {
    expect(validateRule(daily())).toEqual([]);
    expect(validateRule(weekly())).toEqual([]);
    expect(validateRule(monthly("2026-01-31"))).toEqual([]);
    expect(validateRule(custom([1, 3, 5], "2026-11-02"))).toEqual([]);
    expect(validateRule(daily("2026-11-02", { plannedTime: "09:00", endDate: "2026-12-31", deadlineOffsetDays: -1, deadlineTime: "17:00" }))).toEqual([]);
  });
  it("rejects bad weekday sets", () => {
    expect(codes({ ...daily(), weekdays: [1] })).toContain("weekdays:INVALID_WEEKDAYS");
    expect(codes({ ...weekly(), weekdays: [1, 2] })).toContain("weekdays:INVALID_WEEKDAYS");
    expect(codes({ ...custom([1], "2026-11-02"), weekdays: [] })).toContain("weekdays:INVALID_WEEKDAYS");
    expect(codes({ ...custom([1], "2026-11-02"), weekdays: [0, 1] })).toContain("weekdays:INVALID_WEEKDAYS");
    expect(codes({ ...custom([1], "2026-11-02"), weekdays: [1, 8] })).toContain("weekdays:INVALID_WEEKDAYS");
    expect(codes({ ...custom([1], "2026-11-02"), weekdays: [1, 1] })).toContain("weekdays:INVALID_WEEKDAYS");
  });
  it("rejects bad monthly days", () => {
    expect(codes({ ...monthly("2026-01-31"), monthlyDay: null })).toContain("monthlyDay:INVALID_MONTHLY_DAY");
    expect(codes({ ...monthly("2026-01-31"), monthlyDay: 32 })).toContain("monthlyDay:INVALID_MONTHLY_DAY");
    expect(codes({ ...monthly("2026-01-31"), monthlyDay: 0 })).toContain("monthlyDay:INVALID_MONTHLY_DAY");
    expect(codes({ ...daily(), monthlyDay: 5 })).toContain("monthlyDay:INVALID_MONTHLY_DAY");
  });
  it("rejects bad dates, times and end dates", () => {
    expect(codes({ ...daily(), anchorDate: "2026-02-30" })).toContain("anchorDate:INVALID_DATE");
    expect(codes({ ...daily(), plannedTime: "25:00" })).toContain("plannedTime:INVALID_TIME");
    expect(codes({ ...daily(), endDate: "2026-11-01" })).toContain("endDate:END_BEFORE_START");
    expect(codes({ ...daily(), endDate: "soon" })).toContain("endDate:INVALID_DATE");
    expect(validateRule({ ...daily(), endDate: "2026-11-02" })).toEqual([]); // end date = start date is fine
  });
  it("rejects bad deadline settings", () => {
    expect(codes({ ...daily(), deadlineOffsetDays: 3651 })).toContain("deadlineOffsetDays:INVALID_DEADLINE_OFFSET");
    expect(codes({ ...daily(), deadlineOffsetDays: 1.5 })).toContain("deadlineOffsetDays:INVALID_DEADLINE_OFFSET");
    expect(codes({ ...daily(), deadlineTime: "17:00" })).toContain("deadlineTime:DEADLINE_TIME_WITHOUT_DEADLINE");
    expect(codes({ ...daily(), deadlineOffsetDays: 0, deadlineTime: "99:00" })).toContain("deadlineTime:INVALID_TIME");
  });
  it("rejects a first planned date that is not on the schedule", () => {
    expect(codes(custom([1, 3, 5], "2026-11-03"))).toContain("anchorDate:ANCHOR_NOT_ON_SCHEDULE"); // Tuesday
    expect(codes({ ...weekly("2026-11-02"), anchorDate: "2026-11-03" })).toContain("anchorDate:ANCHOR_NOT_ON_SCHEDULE");
    expect(codes({ ...monthly("2026-11-15"), anchorDate: "2026-11-16" })).toContain("anchorDate:ANCHOR_NOT_ON_SCHEDULE");
  });
  it("weekly and monthly adopt the planned date's weekday and day of the month", () => {
    expect(weekly("2026-11-04").weekdays).toEqual([3]);
    expect(monthly("2026-11-17").monthlyDay).toBe(17);
  });
});

describe("occurrence keys", () => {
  it("round-trip and validate", () => {
    expect(buildOccurrence("2026-11-09", null).key).toBe("2026-11-09");
    expect(buildOccurrence("2026-11-09", "09:00").key).toBe("2026-11-09T09:00");
    expect(parseOccurrenceKey("2026-11-09T09:00")).toEqual({ key: "2026-11-09T09:00", date: "2026-11-09", time: "09:00" });
    expect(isOccurrenceKey("2026-11-09")).toBe(true);
    expect(isOccurrenceKey("2026-11-09T09:00")).toBe(true);
    for (const bad of ["", "2026-13-01", "2026-11-09T25:00", "2026-11-09T09:00:00", "2026-11-09 09:00", "x"]) expect(isOccurrenceKey(bad)).toBe(false);
  });
  it("orders by date, then time (date-only counts as 00:00)", () => {
    const keys = ["2026-11-10", "2026-11-09T18:00", "2026-11-09", "2026-11-09T09:00"];
    expect(keys.sort(compareOccurrenceKeys)).toEqual(["2026-11-09", "2026-11-09T09:00", "2026-11-09T18:00", "2026-11-10"]);
    expect(compareOccurrenceKeys("2026-11-09T09:00", "2026-11-09T09:00")).toBe(0);
  });
});
