import { describe, expect, it } from "vitest";

import { daysLeft, isExpired, purgeInstant, retentionCutoff, TRASH_RETENTION_MS } from "@/lib/trash/rules";

const D = new Date("2026-10-10T12:00:00.000Z");
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

describe("Trash retention: exactly 30 x 24 hours", () => {
  it("is 30 days of 24 hours, on the UTC timeline", () => {
    expect(TRASH_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(purgeInstant(D).toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("is not shifted by the clock change on 25 October", () => {
    // A calendar-based "+30 days" in Tallinn would land an hour off; the instant must not.
    const deleted = new Date("2026-10-20T08:00:00.000Z");
    expect(purgeInstant(deleted).getTime() - deleted.getTime()).toBe(30 * 24 * 3600 * 1000);
  });

  it("expires at exactly deletedAt + 30 days, not a millisecond before", () => {
    const boundary = purgeInstant(D);
    expect(isExpired(D, plus(boundary, -1))).toBe(false);
    expect(isExpired(D, boundary)).toBe(true);
    expect(isExpired(D, plus(boundary, 1))).toBe(true);
    expect(isExpired(D, D)).toBe(false);
  });

  it("agrees with the database cutoff: restorable <=> deletedAt > now - 30 days", () => {
    const now = purgeInstant(D);
    // At exactly the boundary the cutoff equals deletedAt, so `deletedAt > cutoff` is false.
    expect(retentionCutoff(now).getTime()).toBe(D.getTime());
    expect(D.getTime() > retentionCutoff(now).getTime()).toBe(false);
    const earlier = plus(now, -1);
    expect(D.getTime() > retentionCutoff(earlier).getTime()).toBe(true);
    // The two rules never disagree.
    for (const offset of [-86_400_000, -1, 0, 1, 86_400_000]) {
      const at = plus(now, offset);
      expect(D.getTime() > retentionCutoff(at).getTime()).toBe(!isExpired(D, at));
    }
  });
});

describe("daysLeft", () => {
  it("counts whole days, rounding up, and is 0 once expired", () => {
    expect(daysLeft(D, D)).toBe(30);
    expect(daysLeft(D, plus(D, 1))).toBe(30);
    expect(daysLeft(D, plus(D, 24 * 3600 * 1000))).toBe(29);
    expect(daysLeft(D, plus(purgeInstant(D), -1))).toBe(1);
    expect(daysLeft(D, purgeInstant(D))).toBe(0);
    expect(daysLeft(D, plus(purgeInstant(D), 5000))).toBe(0);
  });
});
