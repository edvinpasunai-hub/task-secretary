import { describe, expect, it } from "vitest";

import { dueSlots, relevantDeadlineDates, reminderSlots } from "@/lib/reminders/rules";

// Europe/Tallinn: UTC+2 in winter (EET), UTC+3 in summer (EEST).
// Summer time started 2026-03-29 03:00 and ended 2026-10-25 04:00.
const utc = (iso: string) => new Date(iso);
const iso = (slots: Array<{ scheduledAt: Date }>) => slots.map((s) => s.scheduledAt.toISOString());

describe("reminderSlots", () => {
  it("is 09:00 Tallinn on the day before and on the deadline day (winter)", () => {
    const slots = reminderSlots("2026-12-10");
    expect(slots.map((s) => s.type)).toEqual(["DAY_BEFORE", "DUE_DAY"]);
    expect(iso(slots)).toEqual(["2026-12-09T07:00:00.000Z", "2026-12-10T07:00:00.000Z"]);
  });

  it("is 09:00 Tallinn in summer time too (one hour earlier in UTC)", () => {
    expect(iso(reminderSlots("2026-07-15"))).toEqual(["2026-07-14T06:00:00.000Z", "2026-07-15T06:00:00.000Z"]);
  });

  it("follows the clocks going forward (deadline on 2026-03-29)", () => {
    // 28 March 09:00 is still winter time (07:00Z), 29 March 09:00 is summer time (06:00Z).
    expect(iso(reminderSlots("2026-03-29"))).toEqual(["2026-03-28T07:00:00.000Z", "2026-03-29T06:00:00.000Z"]);
  });

  it("follows the clocks going back (deadline on 2026-10-25)", () => {
    // 24 October 09:00 is summer time (06:00Z), 25 October 09:00 is winter time (07:00Z).
    expect(iso(reminderSlots("2026-10-25"))).toEqual(["2026-10-24T06:00:00.000Z", "2026-10-25T07:00:00.000Z"]);
  });

  it("crosses month and year boundaries", () => {
    expect(reminderSlots("2027-01-01")[0].scheduledAt.toISOString()).toBe("2026-12-31T07:00:00.000Z");
    expect(reminderSlots("2028-03-01")[0].scheduledAt.toISOString()).toBe("2028-02-29T07:00:00.000Z");
  });
});

describe("dueSlots", () => {
  it("creates nothing before the day-before moment", () => {
    expect(dueSlots("2026-12-10", utc("2026-12-09T06:59:00Z"))).toEqual([]);
  });

  it("creates the day-before reminder from 09:00 the day before", () => {
    expect(dueSlots("2026-12-10", utc("2026-12-09T07:00:00Z")).map((s) => s.type)).toEqual(["DAY_BEFORE"]);
  });

  it("creates the due-day reminder from 09:00 on the deadline day, without a stale 'tomorrow' one", () => {
    expect(dueSlots("2026-12-10", utc("2026-12-10T06:59:00Z"))).toEqual([]);
    expect(dueSlots("2026-12-10", utc("2026-12-10T07:00:00Z")).map((s) => s.type)).toEqual(["DUE_DAY"]);
  });

  it("a reminder missed while the app was closed is created when it opens", () => {
    // Nobody opened the app on the 9th; on the morning of the 10th the due-day reminder appears.
    expect(dueSlots("2026-12-10", utc("2026-12-10T12:00:00Z")).map((s) => s.type)).toEqual(["DUE_DAY"]);
  });

  it("a deadline set late (tomorrow, after 09:00 today) is reminded at once", () => {
    expect(dueSlots("2026-12-10", utc("2026-12-09T13:00:00Z")).map((s) => s.type)).toEqual(["DAY_BEFORE"]);
  });

  it("creates nothing for deadlines in the past (no historical reminders)", () => {
    expect(dueSlots("2026-12-09", utc("2026-12-10T07:00:00Z"))).toEqual([]);
    expect(dueSlots("2026-01-01", utc("2026-12-10T07:00:00Z"))).toEqual([]);
  });

  it("uses the Tallinn calendar day, not the UTC one", () => {
    // 2026-12-09 22:30Z is already 00:30 on the 10th in Tallinn: it is the deadline day (so no
    // "tomorrow" reminder, which the UTC date would wrongly give) and 09:00 has not come yet.
    expect(dueSlots("2026-12-10", utc("2026-12-09T22:30:00Z"))).toEqual([]);
    // For a deadline on the 11th the 10th is "the day before", and its 09:00 has not come yet.
    expect(dueSlots("2026-12-11", utc("2026-12-09T22:30:00Z"))).toEqual([]);
    // 2026-12-10 21:30Z is 23:30 on the 10th: still the deadline day.
    expect(dueSlots("2026-12-10", utc("2026-12-10T21:30:00Z")).map((s) => s.type)).toEqual(["DUE_DAY"]);
  });

  it("works on the clock-change days", () => {
    // 2026-03-29: 09:00 EEST = 06:00Z.
    expect(dueSlots("2026-03-29", utc("2026-03-29T05:59:00Z"))).toEqual([]);
    expect(dueSlots("2026-03-29", utc("2026-03-29T06:00:00Z")).map((s) => s.type)).toEqual(["DUE_DAY"]);
    // 2026-10-25: 09:00 EET = 07:00Z.
    expect(dueSlots("2026-10-25", utc("2026-10-25T06:59:00Z"))).toEqual([]);
    expect(dueSlots("2026-10-25", utc("2026-10-25T07:00:00Z")).map((s) => s.type)).toEqual(["DUE_DAY"]);
  });
});

describe("relevantDeadlineDates", () => {
  it("is today and tomorrow in Tallinn", () => {
    expect(relevantDeadlineDates(utc("2026-12-09T22:30:00Z"))).toEqual(["2026-12-10", "2026-12-11"]);
    expect(relevantDeadlineDates(utc("2026-12-31T12:00:00Z"))).toEqual(["2026-12-31", "2027-01-01"]);
  });
});
