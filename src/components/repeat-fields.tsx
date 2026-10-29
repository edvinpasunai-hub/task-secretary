"use client";

import { useState } from "react";

import type { TaskFormState } from "@/app/tasks/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LocalDate } from "@/lib/local-time";
import { describeChoice, describeRepeat, describeState, REPEAT_LABELS, WEEKDAY_SHORT } from "@/lib/recurrence/describe";
import type { RepeatScope } from "@/lib/recurrence/form";
import { RECURRENCE_TYPES, type RecurrenceTypeName } from "@/lib/recurrence/rules";
import type { SeriesView } from "@/lib/recurrence/types";
import { cn } from "@/lib/utils";

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

type Props = {
  // The series this task already belongs to (none for a new or ordinary task).
  series: SeriesView | null;
  taskCompleted: boolean;
  // The planned date as typed so far: repeating follows it.
  plannedDate: LocalDate;
  repeatState: TaskFormState["repeat"];
  errors: TaskFormState["errors"];
};

// The "Repeat" part of the task form (new tasks and edits).
// For a task that already repeats, a choice says what a save changes:
// - Only this task: this task alone (the repeat settings below are locked);
// - This and future tasks: the series template and the repeat settings.
export function RepeatFields({ series, taskCompleted, plannedDate, repeatState, errors }: Props) {
  const [scope, setScope] = useState<RepeatScope>(repeatState?.scope ?? "TASK");
  const [type, setType] = useState<RecurrenceTypeName | "NEVER">((repeatState?.repeatType as RecurrenceTypeName | "NEVER" | undefined) ?? series?.type ?? "NEVER");
  const [weekdays, setWeekdays] = useState<number[]>(
    repeatState ? repeatState.repeatWeekdays.map(Number) : series?.type === "CUSTOM_WEEKDAYS" ? series.weekdays : [],
  );

  const repeats = series !== null;
  const stopped = series?.state === "STOPPED";
  // Completed tasks are history: their repeat settings cannot be changed from here.
  const readOnly = repeats && (taskCompleted || stopped);
  const locked = repeats && !readOnly && scope === "TASK";
  const disabled = locked || readOnly;
  const error = (field: "repeatType" | "repeatWeekdays" | "repeatEndDate") => errors?.[field] && (
    <p id={`${field}-error`} className="text-sm text-destructive">{errors[field]}</p>
  );

  const toggleWeekday = (day: number) => setWeekdays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));

  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border p-3 sm:p-4" data-repeat-section>
      <legend className="px-1 text-sm font-medium">Repeat</legend>

      {repeats && (
        <>
          <input type="hidden" name="seriesVersion" value={series.version} />
          <p className="text-sm" data-repeat-summary>
            <span className="font-medium">{describeRepeat(series)}</span>
            <span className="text-muted-foreground"> · {describeState(series.state, series.pausedUntil)}</span>
          </p>
        </>
      )}

      {repeats && !readOnly && (
        <div role="radiogroup" aria-label="What should this save change?" className="flex flex-col gap-2" data-scope-choice>
          {(
            [
              ["TASK", "Only this task", "Changes this task only. The repeat settings and all other tasks stay as they are."],
              ["SERIES", "This and future tasks", "Changes the repeat settings and the shared details (title, description, category, importance, duration) of every unfinished task in the series."],
            ] as const
          ).map(([value, label, help]) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
            >
              <input type="radio" name="scope" value={value} checked={scope === value} onChange={() => setScope(value)} className="mt-1 accent-[var(--color-primary)]" />
              <span>
                <span className="font-medium">{label}</span>
                <span className="block text-muted-foreground">{help}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      {readOnly && (
        <p className="text-sm text-muted-foreground">
          {stopped ? "Repeating was turned off for this task." : "This task is finished. To change how the series repeats, open an unfinished task of the series."}
        </p>
      )}

      {!readOnly && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="repeatType">{repeats ? "Repeats" : "Repeat this task"}</Label>
            <select
              id="repeatType"
              name={disabled ? undefined : "repeatType"}
              value={type}
              disabled={disabled}
              onChange={(event) => setType(event.target.value as RecurrenceTypeName | "NEVER")}
              className={selectClass}
              aria-invalid={errors?.repeatType ? true : undefined}
              aria-describedby={errors?.repeatType ? "repeatType-error" : undefined}
            >
              {(["NEVER", ...RECURRENCE_TYPES] as const).map((value) => (
                <option key={value} value={value}>
                  {REPEAT_LABELS[value]}
                </option>
              ))}
            </select>
            {error("repeatType")}
          </div>

          {type === "CUSTOM_WEEKDAYS" && (
            <fieldset className="flex flex-col gap-2" disabled={disabled}>
              <legend className="mb-1 text-sm font-medium">Weekdays</legend>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAY_SHORT.map((label, index) => {
                  const day = index + 1;
                  return (
                    <label
                      key={day}
                      className={cn(
                        "flex h-10 cursor-pointer items-center justify-center rounded-lg border text-sm has-checked:border-primary has-checked:bg-primary/10 has-checked:font-medium has-checked:text-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                        disabled && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <input type="checkbox" name="repeatWeekdays" value={day} checked={weekdays.includes(day)} onChange={() => toggleWeekday(day)} className="sr-only" />
                      {label}
                    </label>
                  );
                })}
              </div>
              {error("repeatWeekdays")}
            </fieldset>
          )}

          {type !== "NEVER" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="repeatEndDate">
                Ends on <span className="font-normal text-muted-foreground">(optional, inclusive)</span>
              </Label>
              <Input
                id="repeatEndDate"
                name={disabled ? undefined : "repeatEndDate"}
                type="date"
                defaultValue={repeatState?.repeatEndDate ?? series?.endDate ?? ""}
                disabled={disabled}
                className="h-10 w-48"
                aria-invalid={errors?.repeatEndDate ? true : undefined}
                aria-describedby={errors?.repeatEndDate ? "repeatEndDate-error" : undefined}
              />
              {error("repeatEndDate")}
            </div>
          )}

          <p className="text-sm text-muted-foreground" data-repeat-hint>
            {locked
              ? "Choose “This and future tasks” above to change how this task repeats."
              : type === "NEVER"
                ? repeats
                  ? "Never stops the series for good: it cannot be resumed (to take a break, use “Pause repeating” on the task page). Existing tasks stay, and this one becomes an ordinary task."
                  : "This task does not repeat."
                : describeChoice(type, plannedDate || null, weekdays)}
            {!disabled && type !== "NEVER" && " The time of day is the planned time above; leave it empty for a date-only task."}
          </p>
        </>
      )}
    </fieldset>
  );
}
