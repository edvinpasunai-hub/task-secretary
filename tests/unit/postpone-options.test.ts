import { describe, expect, it } from "vitest";

import { addDays, isoWeekday } from "@/lib/recurrence/civil-date";
import { POSTPONE_LABELS, postponeOptions, postponeProblem, presetDate, type PostponePreset } from "@/lib/postpone-rules";

// Which Postpone choices are displayed for a task. The rule (src/lib/postpone-rules.ts): a postponement
// must move the deadline to a day that is after today AND later than the current deadline. A preset
// that does not satisfy that is not offered ("Tomorrow" is hidden for a task already due tomorrow,
// because tomorrow is not later than its deadline).
const PRESETS = Object.keys(POSTPONE_LABELS) as PostponePreset[];
const WEEK_OF_TODAYS = Array.from({ length: 14 }, (_, i) => addDays("2026-11-02", i)); // two weeks, every weekday twice

describe("which Postpone choices are displayed", () => {
  it("exactly the presets that are valid for the task: shown <=> the server would accept it (every weekday x many deadlines)", () => {
    for (const today of WEEK_OF_TODAYS) {
      for (let offset = -10; offset <= 20; offset++) {
        const deadline = addDays(today, offset);
        const shown = postponeOptions(today, deadline).options.map((o) => o.choice);
        const valid = PRESETS.filter((choice) => postponeProblem(presetDate(choice, today), today, deadline) === null);
        expect(shown, `today ${today} (weekday ${isoWeekday(today)}), deadline ${deadline}`).toEqual(valid);
      }
    }
  });

  it("'Tomorrow' is hidden for a task whose deadline is already tomorrow (and for one due later)", () => {
    const today = "2026-10-30"; // Friday
    expect(postponeOptions(today, "2026-10-30").options.map((o) => o.choice)).toContain("tomorrow"); // due today
    expect(postponeOptions(today, "2026-10-29").options.map((o) => o.choice)).toContain("tomorrow"); // overdue
    expect(postponeOptions(today, "2026-10-31").options.map((o) => o.choice)).not.toContain("tomorrow"); // due tomorrow
    expect(postponeOptions(today, "2026-11-01").options.map((o) => o.choice)).not.toContain("tomorrow"); // due the day after
    expect(postponeProblem("2026-10-31", today, "2026-10-31")).toBe("NOT_LATER"); // and the server agrees
  });

  it("an overdue task or one due today is offered every preset", () => {
    for (const today of WEEK_OF_TODAYS) {
      for (const offset of [-30, -1, 0]) {
        expect(postponeOptions(today, addDays(today, offset)).options.map((o) => o.choice), `${today} ${offset}`).toEqual(PRESETS);
      }
    }
  });

  it("every offered date is after today and later than the deadline, and the list is in a stable order", () => {
    for (const today of WEEK_OF_TODAYS) {
      for (let offset = -3; offset <= 10; offset++) {
        const deadline = addDays(today, offset);
        for (const option of postponeOptions(today, deadline).options) {
          expect(option.date > today).toBe(true);
          expect(option.date > deadline).toBe(true);
        }
        expect(postponeOptions(today, deadline).options.map((o) => o.choice)).toEqual(PRESETS.filter((c) => postponeOptions(today, deadline).options.some((o) => o.choice === c)));
      }
    }
  });

  it("'Choose date' accepts exactly the days from the earliest valid day on", () => {
    for (const today of WEEK_OF_TODAYS) {
      for (let offset = -5; offset <= 12; offset++) {
        const deadline = addDays(today, offset);
        const { earliest, latest } = postponeOptions(today, deadline);
        expect(postponeProblem(earliest, today, deadline), `${today} ${deadline}`).toBeNull();
        expect(postponeProblem(addDays(earliest, -1), today, deadline)).not.toBeNull(); // the day before is refused
        expect(postponeProblem(latest, today, deadline)).toBeNull();
        expect(postponeProblem(addDays(latest, 1), today, deadline)).toBe("TOO_FAR");
      }
    }
  });

  it("two presets can land on the same day (by definition): Friday's 'In 3 days' is Monday, which is also 'Next week'; Sunday's 'Tomorrow' is also 'Next week'", () => {
    // Both are shown, each with its date, so the user sees what they get; they are not merged.
    expect(presetDate("in3days", "2026-10-30")).toBe(presetDate("nextWeek", "2026-10-30")); // Friday
    expect(presetDate("tomorrow", "2026-11-01")).toBe(presetDate("nextWeek", "2026-11-01")); // Sunday
    expect(postponeOptions("2026-10-30", "2026-10-29").options.map((o) => o.choice)).toEqual(["tomorrow", "in3days", "nextWeek"]);
  });
});
