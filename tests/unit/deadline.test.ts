import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/recurrence/civil-date";
import { buildOccurrence, deadlineFor, deadlineOffsetFor, nextOccurrenceAfter, ruleFromAnchor, validateRule, type RuleConfig } from "@/lib/recurrence/rules";

// Planned date/time and deadline date/time of a recurring instance.
// Deadline = planned date + N CALENDAR days at a wall-clock time. Never elapsed hours.

const deadline = (offset: number | null, time: string | null, planned: string) => deadlineFor({ deadlineOffsetDays: offset, deadlineTime: time }, planned);

describe("deadlineFor", () => {
  it("no deadline configured → no deadline", () => {
    expect(deadline(null, null, "2026-11-09")).toBeNull();
  });

  it("same day, whole day (offset 0, no time)", () => {
    expect(deadline(0, null, "2026-11-09")).toEqual({ date: "2026-11-09", time: null });
  });

  it("same day with a time", () => {
    expect(deadline(0, "17:00", "2026-11-09")).toEqual({ date: "2026-11-09", time: "17:00" });
  });

  it.each([
    [1, "2026-11-09", "2026-11-10"],
    [3, "2026-11-09", "2026-11-12"],
    [14, "2026-11-09", "2026-11-23"],
    [-1, "2026-11-09", "2026-11-08"],
    [3, "2026-01-30", "2026-02-02"], // across a month end
    [1, "2026-02-28", "2026-03-01"], // non-leap February
    [1, "2028-02-28", "2028-02-29"], // leap February
    [2, "2028-02-28", "2028-03-01"],
    [3, "2026-12-30", "2027-01-02"], // across a year end
    [-2, "2027-01-01", "2026-12-30"],
  ])("offset %i from %s → %s", (offset, planned, expected) => {
    expect(deadline(offset, null, planned)?.date).toBe(expected);
  });

  it("is calculated from the instance's real planned date, so monthly clamping carries through", () => {
    const rule = ruleFromAnchor("MONTHLY", "2026-01-31", { deadlineOffsetDays: 3, deadlineTime: "12:00" });
    const february = nextOccurrenceAfter(rule, { date: "2026-01-31", time: null })!;
    expect(february.date).toBe("2026-02-28"); // clamped
    expect(deadlineFor(rule, february.date)).toEqual({ date: "2026-03-03", time: "12:00" }); // 28 Feb + 3 days
    expect(deadlineFor(rule, "2026-01-31")).toEqual({ date: "2026-02-03", time: "12:00" }); // 31 Jan + 3 days
  });

  it("uses wall-clock times as written, even on a daylight-saving day", () => {
    // 2026-03-29 03:30 does not exist in Tallinn and 2026-10-25 03:30 happens twice:
    // the stored deadline time is still exactly what the series says.
    expect(deadline(1, "03:30", "2026-03-28")).toEqual({ date: "2026-03-29", time: "03:30" });
    expect(deadline(1, "03:30", "2026-10-24")).toEqual({ date: "2026-10-25", time: "03:30" });
    expect(deadline(0, "04:00", "2026-03-29")).toEqual({ date: "2026-03-29", time: "04:00" });
  });

  it("a multi-day offset across a daylight-saving change is exactly that many calendar days", () => {
    expect(deadline(2, "09:00", "2026-03-28")).toEqual({ date: "2026-03-30", time: "09:00" });
    expect(deadline(2, "09:00", "2026-10-24")).toEqual({ date: "2026-10-26", time: "09:00" });
    expect(deadline(7, null, "2026-03-25")).toEqual({ date: "2026-04-01", time: null });
  });
});

describe("planned time × deadline combinations (every one valid, independent of each other)", () => {
  const plannedTimes: Array<string | null> = [null, "09:00"];
  const deadlines: Array<{ label: string; offset: number | null; time: string | null; expected: { date: string; time: string | null } | null }> = [
    { label: "no deadline", offset: null, time: null, expected: null },
    { label: "date-only deadline", offset: 2, time: null, expected: { date: "2026-11-11", time: null } },
    { label: "timed deadline", offset: 2, time: "17:30", expected: { date: "2026-11-11", time: "17:30" } },
  ];

  for (const plannedTime of plannedTimes) {
    for (const d of deadlines) {
      it(`planned ${plannedTime ?? "date-only"} with ${d.label}`, () => {
        const rule: RuleConfig = ruleFromAnchor("WEEKLY", "2026-11-09", { plannedTime, deadlineOffsetDays: d.offset, deadlineTime: d.time });
        expect(validateRule(rule)).toEqual([]);
        const occurrence = buildOccurrence("2026-11-09", plannedTime);
        expect(occurrence.time).toBe(plannedTime);
        expect(deadlineFor(rule, occurrence.date)).toEqual(d.expected);
      });
    }
  }

  it("a deadline earlier than the planned time on the same day is allowed (the app only warns about it)", () => {
    const rule = ruleFromAnchor("DAILY", "2026-11-09", { plannedTime: "18:00", deadlineOffsetDays: 0, deadlineTime: "09:00" });
    expect(validateRule(rule)).toEqual([]);
    expect(deadlineFor(rule, "2026-11-09")).toEqual({ date: "2026-11-09", time: "09:00" });
  });

  it("a deadline before the planned date (negative offset) is allowed", () => {
    const rule = ruleFromAnchor("DAILY", "2026-11-09", { deadlineOffsetDays: -1 });
    expect(validateRule(rule)).toEqual([]);
    expect(deadlineFor(rule, "2026-11-09")?.date).toBe("2026-11-08");
  });
});

describe("deadlineOffsetFor (used when an ordinary task becomes recurring)", () => {
  it.each([
    ["2026-11-09", null, null],
    ["2026-11-09", "2026-11-09", 0],
    ["2026-11-09", "2026-11-12", 3],
    ["2026-11-09", "2026-11-07", -2],
    ["2026-01-31", "2026-02-03", 3],
    ["2028-02-28", "2028-03-01", 2],
    ["2026-03-28", "2026-03-30", 2], // across the spring change: still whole calendar days
    ["2026-10-24", "2026-10-26", 2], // across the autumn change
    ["2026-12-30", "2027-01-02", 3],
  ])("planned %s, deadline %s → offset %s", (planned, deadlineDate, offset) => {
    expect(deadlineOffsetFor(planned, deadlineDate)).toBe(offset);
  });

  it("round-trips: applying the captured offset to the same planned date gives the original deadline", () => {
    for (const [planned, deadlineDate] of [["2026-03-28", "2026-03-30"], ["2026-10-24", "2026-10-26"], ["2028-02-27", "2028-03-02"], ["2026-11-09", "2026-11-05"]]) {
      const offset = deadlineOffsetFor(planned, deadlineDate)!;
      expect(addDays(planned, offset)).toBe(deadlineDate);
      expect(deadlineFor({ deadlineOffsetDays: offset, deadlineTime: null }, planned)?.date).toBe(deadlineDate);
    }
  });
});
