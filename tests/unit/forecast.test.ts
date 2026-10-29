import { describe, expect, it } from "vitest";

import { forecastOccurrences, MAX_FORECAST_LIMIT, type ForecastInput } from "@/lib/recurrence/forecast";
import { ruleFromAnchor } from "@/lib/recurrence/rules";

// Mondays: 2, 9, 16, 23, 30 Nov and 7, 14, 21, 28 Dec 2026.
const NOW = { date: "2026-11-12", time: "10:00" }; // a Thursday

function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    rule: ruleFromAnchor("WEEKLY", "2026-11-02"),
    state: "ACTIVE",
    pausedUntil: null,
    materializedKeys: ["2026-11-02", "2026-11-09", "2026-11-16"],
    now: NOW,
    ...overrides,
  };
}
const keys = (i: ForecastInput) => forecastOccurrences(i).map((o) => o.key);

describe("forecastOccurrences", () => {
  it("lists upcoming occurrences after the latest existing one, never repeating existing ones", () => {
    expect(keys(input({ limit: 3 }))).toEqual(["2026-11-23", "2026-11-30", "2026-12-07"]);
  });

  it("starts after now when every existing occurrence is in the past", () => {
    expect(keys(input({ materializedKeys: ["2026-11-02"], limit: 2 }))).toEqual(["2026-11-16", "2026-11-23"]);
    expect(keys(input({ materializedKeys: [], limit: 2 }))).toEqual(["2026-11-16", "2026-11-23"]);
  });

  it("respects the inclusive end date", () => {
    expect(keys(input({ rule: ruleFromAnchor("WEEKLY", "2026-11-02", { endDate: "2026-11-30" }), limit: 10 }))).toEqual(["2026-11-23", "2026-11-30"]);
    expect(keys(input({ rule: ruleFromAnchor("WEEKLY", "2026-11-02", { endDate: "2026-11-16" }) }))).toEqual([]);
  });

  it("respects an `until` date (inclusive) and the limit", () => {
    expect(keys(input({ until: "2026-12-07", limit: 50 }))).toEqual(["2026-11-23", "2026-11-30", "2026-12-07"]);
    expect(keys(input({ limit: 1 }))).toEqual(["2026-11-23"]);
    expect(keys(input({ limit: 0 }))).toEqual([]);
  });

  it("caps the limit", () => {
    const daily = ruleFromAnchor("DAILY", "2026-11-02");
    expect(forecastOccurrences(input({ rule: daily, materializedKeys: [], limit: 10_000 })).length).toBe(MAX_FORECAST_LIMIT);
  });

  it("an ended or stopped series has no forecast", () => {
    expect(keys(input({ state: "ENDED" }))).toEqual([]);
    expect(keys(input({ state: "STOPPED" }))).toEqual([]);
  });

  it("a series paused indefinitely has no forecast; paused until a date forecasts from that date on", () => {
    expect(keys(input({ state: "PAUSED", pausedUntil: null }))).toEqual([]);
    // Paused until Tue 24 Nov: Monday 23 Nov is skipped, the next one is Mon 30 Nov.
    expect(keys(input({ state: "PAUSED", pausedUntil: "2026-11-24", limit: 2 }))).toEqual(["2026-11-30", "2026-12-07"]);
    // A pause that ends ON a Monday includes that Monday.
    expect(keys(input({ state: "PAUSED", pausedUntil: "2026-11-30", limit: 1 }))).toEqual(["2026-11-30"]);
  });

  it("works for timed series and uses Tallinn time", () => {
    const rule = ruleFromAnchor("DAILY", "2026-11-02", { plannedTime: "09:00" });
    expect(keys(input({ rule, materializedKeys: ["2026-11-12T09:00"], now: { date: "2026-11-12", time: "08:00" }, limit: 2 }))).toEqual(["2026-11-13T09:00", "2026-11-14T09:00"]);
    // Same-day later occurrence is allowed when nothing exists yet for today.
    expect(keys(input({ rule, materializedKeys: [], now: { date: "2026-11-12", time: "08:00" }, limit: 1 }))).toEqual(["2026-11-12T09:00"]);
  });

  it("monthly forecasts keep the original day", () => {
    const rule = ruleFromAnchor("MONTHLY", "2026-01-31");
    expect(keys(input({ rule, materializedKeys: ["2026-01-31"], now: { date: "2026-01-31", time: "09:00" }, limit: 3 }))).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("is pure: it does not modify its input", () => {
    const frozen = Object.freeze(input({ materializedKeys: Object.freeze(["2026-11-02", "2026-11-09"]) as string[] }));
    expect(() => forecastOccurrences(frozen)).not.toThrow();
    expect(frozen.materializedKeys).toEqual(["2026-11-02", "2026-11-09"]);
    expect(forecastOccurrences(frozen)).toEqual(forecastOccurrences(frozen)); // same input, same answer
  });
});
