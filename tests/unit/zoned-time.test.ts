import { describe, expect, it } from "vitest";

import { offsetMinutesAt, wallClockToInstant } from "@/lib/recurrence/zoned-time";

const TALLINN = "Europe/Tallinn";
const utc = (y: number, m: number, d: number, h: number, min: number) => Date.UTC(y, m - 1, d, h, min);

describe("offsetMinutesAt", () => {
  it("reads Tallinn winter and summer offsets, and other zones", () => {
    expect(offsetMinutesAt(utc(2026, 1, 15, 12, 0), TALLINN)).toBe(120);
    expect(offsetMinutesAt(utc(2026, 7, 15, 12, 0), TALLINN)).toBe(180);
    expect(offsetMinutesAt(utc(2026, 7, 15, 12, 0), "UTC")).toBe(0);
    expect(offsetMinutesAt(utc(2026, 7, 15, 12, 0), "Asia/Kolkata")).toBe(330);
    expect(offsetMinutesAt(utc(2026, 1, 15, 12, 0), "America/New_York")).toBe(-300);
  });

  it("switches exactly at the 2026 Tallinn transitions (01:00 UTC)", () => {
    expect(offsetMinutesAt(utc(2026, 3, 29, 0, 59), TALLINN)).toBe(120);
    expect(offsetMinutesAt(utc(2026, 3, 29, 1, 0), TALLINN)).toBe(180);
    expect(offsetMinutesAt(utc(2026, 10, 25, 0, 59), TALLINN)).toBe(180);
    expect(offsetMinutesAt(utc(2026, 10, 25, 1, 0), TALLINN)).toBe(120);
  });
});

describe("wallClockToInstant (Europe/Tallinn)", () => {
  it("converts ordinary winter and summer wall times", () => {
    expect(wallClockToInstant("2026-01-15", "09:00", TALLINN)).toBe(utc(2026, 1, 15, 7, 0));
    expect(wallClockToInstant("2026-07-15", "09:00", TALLINN)).toBe(utc(2026, 7, 15, 6, 0));
    expect(wallClockToInstant("2026-07-15", "00:00", TALLINN)).toBe(utc(2026, 7, 14, 21, 0));
    expect(wallClockToInstant("2026-01-15", "23:59", TALLINN)).toBe(utc(2026, 1, 15, 21, 59));
  });

  it("spring forward: a time that does not exist is shifted forward by the gap", () => {
    // 2026-03-29: clocks jump 03:00 → 04:00, so 03:00-03:59 never happens.
    expect(wallClockToInstant("2026-03-29", "02:59", TALLINN)).toBe(utc(2026, 3, 29, 0, 59)); // still EET
    expect(wallClockToInstant("2026-03-29", "03:00", TALLINN)).toBe(utc(2026, 3, 29, 1, 0)); // = 04:00 EEST
    expect(wallClockToInstant("2026-03-29", "03:30", TALLINN)).toBe(utc(2026, 3, 29, 1, 30)); // = 04:30 EEST
    expect(wallClockToInstant("2026-03-29", "03:59", TALLINN)).toBe(utc(2026, 3, 29, 1, 59));
    expect(wallClockToInstant("2026-03-29", "04:00", TALLINN)).toBe(utc(2026, 3, 29, 1, 0));
  });

  it("autumn back: a time that happens twice means its FIRST occurrence", () => {
    // 2026-10-25: clocks go 04:00 → 03:00, so 03:00-03:59 happens twice.
    expect(wallClockToInstant("2026-10-25", "02:59", TALLINN)).toBe(utc(2026, 10, 24, 23, 59)); // EEST
    expect(wallClockToInstant("2026-10-25", "03:00", TALLINN)).toBe(utc(2026, 10, 25, 0, 0)); // first (EEST)
    expect(wallClockToInstant("2026-10-25", "03:30", TALLINN)).toBe(utc(2026, 10, 25, 0, 30)); // first (EEST)
    expect(wallClockToInstant("2026-10-25", "03:59", TALLINN)).toBe(utc(2026, 10, 25, 0, 59));
    expect(wallClockToInstant("2026-10-25", "04:00", TALLINN)).toBe(utc(2026, 10, 25, 2, 0)); // unique, EET
  });

  it("keeps the wall-clock time one day to the next across both changes", () => {
    const hours = (a: number, b: number) => (b - a) / 3_600_000;
    expect(hours(wallClockToInstant("2026-03-28", "09:00", TALLINN), wallClockToInstant("2026-03-29", "09:00", TALLINN))).toBe(23);
    expect(hours(wallClockToInstant("2026-10-24", "09:00", TALLINN), wallClockToInstant("2026-10-25", "09:00", TALLINN))).toBe(25); // the 25-hour day
    expect(hours(wallClockToInstant("2026-10-25", "09:00", TALLINN), wallClockToInstant("2026-10-26", "09:00", TALLINN))).toBe(24); // after the change: normal again
    expect(hours(wallClockToInstant("2026-11-09", "09:00", TALLINN), wallClockToInstant("2026-11-10", "09:00", TALLINN))).toBe(24);
  });

  it("is deterministic and works for other zones too", () => {
    expect(wallClockToInstant("2026-03-29", "03:30", TALLINN)).toBe(wallClockToInstant("2026-03-29", "03:30", TALLINN));
    // New York 2026-03-08: 02:00 → 03:00, so 02:30 does not exist → 03:30 EDT (07:30 UTC).
    expect(wallClockToInstant("2026-03-08", "02:30", "America/New_York")).toBe(utc(2026, 3, 8, 7, 30));
    expect(wallClockToInstant("2026-06-01", "12:00", "UTC")).toBe(utc(2026, 6, 1, 12, 0));
  });
});
