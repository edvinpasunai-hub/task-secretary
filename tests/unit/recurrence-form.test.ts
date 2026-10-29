import { describe, expect, it } from "vitest";

import { describeChoice, describeRepeat, describeState } from "@/lib/recurrence/describe";
import { buildSeriesPatch, issueFieldErrors, parseRepeatForm, recurrenceMessage, type FormFields, type TaskAsLoaded } from "@/lib/recurrence/form";
import type { RecurrenceTypeName } from "@/lib/recurrence/rules";

function form(entries: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  return data;
}

describe("describeRepeat", () => {
  const base = { weekdays: [] as number[], monthlyDay: null, plannedTime: null, endDate: null };
  it("describes every type in plain words", () => {
    expect(describeRepeat({ ...base, type: "DAILY" })).toBe("Every day");
    expect(describeRepeat({ ...base, type: "WEEKLY", weekdays: [1] })).toBe("Every Monday");
    expect(describeRepeat({ ...base, type: "WEEKLY", weekdays: [7] })).toBe("Every Sunday");
    expect(describeRepeat({ ...base, type: "CUSTOM_WEEKDAYS", weekdays: [5, 1, 3] })).toBe("Every Monday, Wednesday and Friday");
    expect(describeRepeat({ ...base, type: "CUSTOM_WEEKDAYS", weekdays: [2, 4] })).toBe("Every Tuesday and Thursday");
    expect(describeRepeat({ ...base, type: "CUSTOM_WEEKDAYS", weekdays: [6] })).toBe("Every Saturday");
  });
  it("monthly names the day and warns about short months", () => {
    expect(describeRepeat({ ...base, type: "MONTHLY", monthlyDay: 15 })).toBe("On the 15th of every month");
    expect(describeRepeat({ ...base, type: "MONTHLY", monthlyDay: 31 })).toBe("On the 31st of every month (the last day in shorter months)");
    for (const [day, text] of [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [23, "23rd"]] as const) {
      expect(describeRepeat({ ...base, type: "MONTHLY", monthlyDay: day })).toContain(`the ${text} of`);
    }
  });
  it("adds the time of day and the end date", () => {
    expect(describeRepeat({ ...base, type: "DAILY", plannedTime: "09:00" })).toBe("Every day at 09:00");
    expect(describeRepeat({ ...base, type: "WEEKLY", weekdays: [1], plannedTime: "09:00", endDate: "2026-12-14" })).toBe("Every Monday at 09:00, until Mon, 14 Dec 2026");
  });
  it("describes the series state", () => {
    expect(describeState("ACTIVE", null)).toBe("Active");
    expect(describeState("PAUSED", null)).toBe("Paused");
    expect(describeState("PAUSED", "2026-12-01")).toBe("Paused until Tue, 1 Dec 2026");
    expect(describeState("ENDED", null)).toBe("Ended");
    expect(describeState("STOPPED", null)).toBe("Stopped");
  });
  it("describes what a choice means for the planned date", () => {
    expect(describeChoice("NEVER", "2026-11-02", [])).toBe("");
    expect(describeChoice("WEEKLY", null, [])).toMatch(/Choose a planned date/);
    expect(describeChoice("WEEKLY", "2026-11-04", [])).toBe("Repeats every Wednesday, like the planned date.");
    expect(describeChoice("MONTHLY", "2026-01-31", [])).toBe("Repeats on the 31st of every month, or the last day of shorter months.");
    expect(describeChoice("MONTHLY", "2026-01-15", [])).toBe("Repeats on the 15th of every month.");
    expect(describeChoice("CUSTOM_WEEKDAYS", "2026-11-02", [])).toBe("Choose at least one weekday.");
    expect(describeChoice("CUSTOM_WEEKDAYS", "2026-11-02", [3, 1])).toBe("Repeats every Monday and Wednesday.");
    expect(describeChoice("DAILY", "2026-11-02", [])).toBe("A new task appears every day.");
  });
});

describe("parseRepeatForm", () => {
  it("no repeat fields at all means Never", () => {
    expect(parseRepeatForm(form({}))).toMatchObject({ choice: { type: "NEVER" }, scope: "TASK", seriesVersion: null, errors: {} });
    expect(parseRepeatForm(form({ repeatType: "NEVER" })).choice).toEqual({ type: "NEVER" });
  });
  it("reads each repeat type", () => {
    expect(parseRepeatForm(form({ repeatType: "DAILY" })).choice).toEqual({ type: "DAILY", weekdays: [], endDate: null });
    expect(parseRepeatForm(form({ repeatType: "WEEKLY", repeatWeekdays: ["3"] })).choice).toEqual({ type: "WEEKLY", weekdays: [], endDate: null }); // weekly follows the planned date
    expect(parseRepeatForm(form({ repeatType: "MONTHLY", repeatEndDate: "2027-01-31" })).choice).toEqual({ type: "MONTHLY", weekdays: [], endDate: "2027-01-31" });
    expect(parseRepeatForm(form({ repeatType: "CUSTOM_WEEKDAYS", repeatWeekdays: ["5", "1", "3", "1"] })).choice).toEqual({ type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5], endDate: null });
  });
  it("custom weekdays need at least one valid weekday", () => {
    expect(parseRepeatForm(form({ repeatType: "CUSTOM_WEEKDAYS" })).errors.repeatWeekdays).toBe("Please choose at least one weekday.");
    for (const bad of ["0", "8", "x", "1.5", ""]) {
      expect(parseRepeatForm(form({ repeatType: "CUSTOM_WEEKDAYS", repeatWeekdays: [bad] })).errors.repeatWeekdays).toBeTruthy();
    }
  });
  it("refuses unknown repeat types and bad end dates", () => {
    for (const bad of ["YEARLY", "daily", "EVERY_DAY", "<script>", "NEVER;DROP"]) {
      expect(parseRepeatForm(form({ repeatType: bad })).errors.repeatType).toBe("Please choose how often the task repeats.");
    }
    for (const bad of ["soon", "2026-02-30", "2026-13-01", "01/02/2026"]) {
      expect(parseRepeatForm(form({ repeatType: "DAILY", repeatEndDate: bad })).errors.repeatEndDate).toBe("Please enter a valid end date.");
    }
    expect(parseRepeatForm(form({ repeatType: "DAILY", repeatEndDate: "  " })).choice).toEqual({ type: "DAILY", weekdays: [], endDate: null });
  });
  it("scope is 'this task only' unless the future scope is explicitly chosen", () => {
    expect(parseRepeatForm(form({})).scope).toBe("TASK");
    expect(parseRepeatForm(form({ scope: "SERIES" })).scope).toBe("SERIES");
    for (const bad of ["series", "ALL", "", "TASK; SERIES"]) expect(parseRepeatForm(form({ scope: bad })).scope).toBe("TASK");
  });
  it("reads the series version only when it is a sensible whole number", () => {
    expect(parseRepeatForm(form({ seriesVersion: "7" })).seriesVersion).toBe(7);
    for (const bad of ["", "0", "-1", "1.5", "abc", "99999999"]) expect(parseRepeatForm(form({ seriesVersion: bad })).seriesVersion).toBeNull();
  });
  it("ignores fields it does not know (a userId, a series id)", () => {
    const parsed = parseRepeatForm(form({ repeatType: "DAILY", userId: "evil", seriesId: "evil", state: "STOPPED" }));
    expect(parsed.choice).toEqual({ type: "DAILY", weekdays: [], endDate: null });
    expect(JSON.stringify(parsed)).not.toContain("evil");
  });
  it("keeps what was typed so an error can show it again", () => {
    const parsed = parseRepeatForm(form({ repeatType: "CUSTOM_WEEKDAYS", repeatWeekdays: ["1", "3"], repeatEndDate: "2026-12-31", scope: "SERIES" }));
    expect(parsed.values).toEqual({ repeatType: "CUSTOM_WEEKDAYS", repeatWeekdays: ["1", "3"], repeatEndDate: "2026-12-31", scope: "SERIES" });
  });
});

describe("issueFieldErrors and recurrenceMessage", () => {
  it("maps rule problems to the form field they belong to", () => {
    const errors = issueFieldErrors([
      { field: "anchorDate", code: "ANCHOR_NOT_ON_SCHEDULE", message: "The planned date does not fall on the chosen days." },
      { field: "weekdays", code: "INVALID_WEEKDAYS", message: "Please choose at least one weekday." },
      { field: "endDate", code: "END_BEFORE_START", message: "The end date cannot be before the first planned date." },
      { field: "deadlineOffsetDays", code: "INVALID_DEADLINE_OFFSET", message: "The deadline must be within 3650 days of the planned date." },
      { field: "plannedTime", code: "INVALID_TIME", message: "Please enter a valid time, for example 14:30." },
    ]);
    expect(errors).toEqual({
      plannedDate: "The planned date does not fall on the chosen days.",
      repeatWeekdays: "Please choose at least one weekday.",
      repeatEndDate: "The end date cannot be before the first planned date.",
      deadlineDate: "The deadline must be within 3650 days of the planned date.",
      plannedTime: "Please enter a valid time, for example 14:30.",
    });
    expect(issueFieldErrors(undefined)).toEqual({});
  });
  it("gives one calm sentence for every kind of failure", () => {
    expect(recurrenceMessage({ code: "CONFLICT", message: "x", currentVersion: 4 })).toMatch(/changed somewhere else.*Nothing was saved/);
    expect(recurrenceMessage({ code: "SERIES_STOPPED", message: "x" })).toMatch(/turned off/);
    expect(recurrenceMessage({ code: "OCCURRENCE_CONFLICT", message: "x" })).toMatch(/already has that date/);
    expect(recurrenceMessage({ code: "RECONCILE_FAILED", message: "x" })).toMatch(/Nothing was saved/);
    expect(recurrenceMessage({ code: "VALIDATION", message: "Please enter a title." })).toBe("Please enter a title.");
    for (const code of ["NOT_FOUND", "NOT_RECURRING", "ALREADY_RECURRING"] as const) expect(recurrenceMessage({ code, message: "x" })).toMatch(/\.$/);
  });
});

describe("buildSeriesPatch: only what the form changed", () => {
  const loaded: TaskAsLoaded = {
    title: "Report", description: "text", importance: "NORMAL", estimatedMinutes: 30, categoryId: "cat1",
    plannedDate: "2026-11-09", plannedTime: "09:00", deadlineDate: "2026-11-12", deadlineTime: "17:00",
  };
  const form: FormFields = { ...loaded, plannedDate: "2026-11-09" };
  type Rule = { type: RecurrenceTypeName; weekdays: number[]; endDate: string | null };
  const series: Rule = { type: "WEEKLY", weekdays: [1], endDate: null };
  const weekly: Rule = { type: "WEEKLY", weekdays: [], endDate: null };
  const patch = (changes: Partial<FormFields>, repeat: Rule = weekly, s: Rule = series) => buildSeriesPatch({ ...form, ...changes }, loaded, s, repeat);

  it("saving without any change sends an empty patch", () => {
    expect(patch({})).toEqual({});
  });
  it("each template field is included only when it differs", () => {
    expect(patch({ title: "New" })).toEqual({ title: "New" });
    expect(patch({ description: null })).toEqual({ description: null });
    expect(patch({ importance: "HIGH" })).toEqual({ importance: "HIGH" });
    expect(patch({ estimatedMinutes: null })).toEqual({ estimatedMinutes: null });
    expect(patch({ categoryId: null })).toEqual({ categoryId: null });
    expect(patch({ title: "New", importance: "LOW" })).toEqual({ title: "New", importance: "LOW" });
  });
  it("the time of day can be added, changed and removed", () => {
    expect(patch({ plannedTime: "10:30" })).toEqual({ plannedTime: "10:30" });
    expect(patch({ plannedTime: null })).toEqual({ plannedTime: null });
    const dateOnly = { ...loaded, plannedTime: null };
    expect(buildSeriesPatch({ ...form, plannedTime: "08:00" }, dateOnly, series, weekly)).toEqual({ plannedTime: "08:00" });
  });
  it("moving only the planned date (a postponement) does not touch the rule", () => {
    expect(patch({ plannedDate: "2026-11-11" })).toEqual({});
  });
  it("changing the deadline changes the rule's offset from the planned date in the form", () => {
    expect(patch({ deadlineDate: "2026-11-14" })).toEqual({ deadlineOffsetDays: 5, deadlineTime: "17:00" });
    expect(patch({ deadlineTime: "12:00" })).toEqual({ deadlineOffsetDays: 3, deadlineTime: "12:00" });
    expect(patch({ deadlineDate: "2026-11-14", plannedDate: "2026-11-10" })).toEqual({ deadlineOffsetDays: 4, deadlineTime: "17:00" });
    expect(patch({ deadlineDate: null, deadlineTime: null })).toEqual({ deadlineOffsetDays: null, deadlineTime: null });
    expect(patch({ deadlineDate: "2026-11-09" })).toEqual({ deadlineOffsetDays: 0, deadlineTime: "17:00" });
  });
  it("repeat type, weekdays and end date", () => {
    expect(patch({}, { type: "DAILY", weekdays: [], endDate: null })).toEqual({ type: "DAILY" });
    expect(patch({}, { type: "MONTHLY", weekdays: [], endDate: null })).toEqual({ type: "MONTHLY" });
    expect(patch({}, { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3], endDate: null })).toEqual({ type: "CUSTOM_WEEKDAYS", weekdays: [1, 3] });
    expect(patch({}, weekly, { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3], endDate: null })).toEqual({ type: "WEEKLY" });
    expect(patch({}, { type: "CUSTOM_WEEKDAYS", weekdays: [3, 1], endDate: null }, { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3], endDate: null })).toEqual({}); // same set
    expect(patch({}, { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5], endDate: null }, { type: "CUSTOM_WEEKDAYS", weekdays: [1, 3], endDate: null })).toEqual({ type: "CUSTOM_WEEKDAYS", weekdays: [1, 3, 5] });
    expect(patch({}, { ...weekly, endDate: "2026-12-31" })).toEqual({ endDate: "2026-12-31" });
    expect(patch({}, weekly, { ...series, endDate: "2026-12-31" })).toEqual({ endDate: null });
  });
  it("combined changes", () => {
    expect(patch({ title: "New", plannedTime: null }, { type: "DAILY", weekdays: [], endDate: "2027-01-01" })).toEqual({ title: "New", plannedTime: null, type: "DAILY", endDate: "2027-01-01" });
  });
});
