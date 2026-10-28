"use client";

import { AlertTriangle, LoaderCircle } from "lucide-react";
import Link from "next/link";
import {
  startTransition,
  useActionState,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";

import type { TaskFormState } from "@/app/tasks/actions";
import type { TaskStatus } from "@/generated/prisma/enums";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IMPORTANCE_LABELS, IMPORTANCE_LEVELS, isPlannedAfterDeadline } from "@/lib/task-rules";
import type { TaskFormField } from "@/lib/task-validation";
import type { TaskView } from "@/lib/tasks";
import { cn } from "@/lib/utils";

type TaskFormProps = {
  action: (state: TaskFormState, formData: FormData) => Promise<TaskFormState>;
  task?: TaskView;
  submitLabel: string;
};

// Lets the status buttons on the task page work together with the edit form.
export type TaskFormHandle = {
  hasUnsavedChanges: () => boolean;
  // Saves the form and the new status together. Call inside startTransition.
  saveWithStatus: (status: TaskStatus) => void;
  discardChanges: () => void;
};

type FieldsHandle = Omit<TaskFormHandle, "discardChanges">;

// Next.js keeps visited pages alive (hidden) in memory. Remounting the form
// whenever it is hidden means it never reappears half-filled after saving or
// leaving; editing also remounts when the saved task changes.
export function TaskForm({ ref, ...props }: TaskFormProps & { ref?: Ref<TaskFormHandle> }) {
  const [resetKey, setResetKey] = useState(0);
  const fields = useRef<FieldsHandle>(null);
  useLayoutEffect(() => () => setResetKey((key) => key + 1), []);
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => fields.current?.hasUnsavedChanges() ?? false,
    saveWithStatus: (status) => fields.current?.saveWithStatus(status),
    discardChanges: () => setResetKey((key) => key + 1),
  }));
  return <TaskFormFields ref={fields} key={`${props.task?.updatedAt ?? "new"}-${resetKey}`} {...props} />;
}

// The form's current values, in a form that can be compared with ===.
const snapshot = (form: HTMLFormElement) => JSON.stringify([...new FormData(form).entries()]);

function durationParts(minutes: number | null | undefined) {
  if (!minutes) return { hours: "", minutes: "" };
  return { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) };
}

function TaskFormFields({ action, task, submitLabel, ref }: TaskFormProps & { ref: Ref<FieldsHandle> }) {
  const [state, formAction, pending] = useActionState(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const savedValues = useRef<string | null>(null);

  // Remember the values the form opened with, to detect unsaved changes later.
  useLayoutEffect(() => {
    if (formRef.current) savedValues.current = snapshot(formRef.current);
  }, []);

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => !!formRef.current && snapshot(formRef.current) !== savedValues.current,
    saveWithStatus: (status) => {
      if (!formRef.current) return;
      const formData = new FormData(formRef.current);
      formData.set("status", status);
      formAction(formData);
    },
  }));

  // After a failed save, move the keyboard focus to the first field with an error.
  useEffect(() => {
    if (state.errors) formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
  }, [state]);
  const initial = durationParts(task?.estimatedMinutes);
  const value = (field: TaskFormField, fallback: string | null | undefined) => state.values?.[field] ?? fallback ?? "";

  // Date and time fields are controlled so the "planned after deadline" warning updates live.
  const [timing, setTiming] = useState({
    plannedDate: value("plannedDate", task?.plannedDate),
    plannedTime: value("plannedTime", task?.plannedTime),
    deadlineDate: value("deadlineDate", task?.deadlineDate),
    deadlineTime: value("deadlineTime", task?.deadlineTime),
  });
  const setField = (field: keyof typeof timing) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setTiming((current) => ({ ...current, [field]: event.target.value }));

  const plannedAfterDeadline = isPlannedAfterDeadline({
    plannedDate: timing.plannedDate || null,
    plannedTime: timing.plannedTime || null,
    deadlineDate: timing.deadlineDate || null,
    deadlineTime: timing.deadlineTime || null,
  });

  // Submit without React's automatic form reset, so typed values stay visible
  // when the server reports a validation error.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const error = (field: TaskFormField) =>
    state.errors?.[field] && (
      <p id={`${field}-error`} className="text-sm text-destructive">
        {state.errors[field]}
      </p>
    );
  const invalid = (field: TaskFormField) =>
    state.errors?.[field] ? { "aria-invalid": true, "aria-describedby": `${field}-error` } : {};

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
      {task && <input type="hidden" name="id" value={task.id} />}

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          name="title"
          defaultValue={value("title", task?.title)}
          maxLength={200}
          className="h-10"
          autoFocus={!task}
          {...invalid("title")}
        />
        {error("title")}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="description"
          name="description"
          defaultValue={value("description", task?.description)}
          maxLength={5000}
          rows={3}
          {...invalid("description")}
        />
        {error("description")}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Importance</legend>
        <div className="grid grid-cols-3 gap-2">
          {IMPORTANCE_LEVELS.map((level) => (
            <label
              key={level}
              className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border text-sm has-checked:border-primary has-checked:bg-primary/10 has-checked:font-medium has-checked:text-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
            >
              <input
                type="radio"
                name="importance"
                value={level}
                defaultChecked={value("importance", task?.importance ?? "NORMAL") === level}
                className="sr-only"
              />
              {IMPORTANCE_LABELS[level]}
            </label>
          ))}
        </div>
        {error("importance")}
      </fieldset>

      <DateTimeField
        legend="Planned for"
        hint="When you intend to work on it."
        prefix="planned"
        date={timing.plannedDate}
        time={timing.plannedTime}
        onDate={setField("plannedDate")}
        onTime={setField("plannedTime")}
        onClear={() => setTiming((t) => ({ ...t, plannedDate: "", plannedTime: "" }))}
        errors={[error("plannedDate"), error("plannedTime")]}
        invalid={invalid}
      />

      <DateTimeField
        legend="Deadline"
        hint="When it must be finished."
        prefix="deadline"
        date={timing.deadlineDate}
        time={timing.deadlineTime}
        onDate={setField("deadlineDate")}
        onTime={setField("deadlineTime")}
        onClear={() => setTiming((t) => ({ ...t, deadlineDate: "", deadlineTime: "" }))}
        errors={[error("deadlineDate"), error("deadlineTime")]}
        invalid={invalid}
      />

      {plannedAfterDeadline && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          The planned time is later than the deadline. You can still save, but the task may be finished too late.
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          Estimated duration <span className="font-normal text-muted-foreground">(optional)</span>
        </legend>
        <div className="flex items-center gap-2">
          <Input
            id="durationHours"
            name="durationHours"
            type="number"
            inputMode="numeric"
            min={0}
            max={168}
            defaultValue={value("durationHours", initial.hours)}
            className="h-10 w-20"
            aria-label="Hours"
            {...invalid("durationHours")}
          />
          <span className="text-sm text-muted-foreground">h</span>
          <Input
            id="durationMinutes"
            name="durationMinutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={5}
            defaultValue={value("durationMinutes", initial.minutes)}
            className="h-10 w-20"
            aria-label="Minutes"
            {...invalid("durationMinutes")}
          />
          <span className="text-sm text-muted-foreground">min</span>
        </div>
        {error("durationHours")}
        {error("durationMinutes")}
      </fieldset>

      {state.message && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Link href="/" className={buttonVariants({ variant: "outline", size: "lg", className: "h-10" })}>
          Cancel
        </Link>
        <Button type="submit" size="lg" className="h-10" disabled={pending}>
          {pending && <LoaderCircle className="animate-spin" aria-hidden />}
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

type DateTimeFieldProps = {
  legend: string;
  hint: string;
  prefix: "planned" | "deadline";
  date: string;
  time: string;
  onDate: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onTime: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  errors: React.ReactNode[];
  invalid: (field: TaskFormField) => object;
};

function DateTimeField({ legend, hint, prefix, date, time, onDate, onTime, onClear, errors, invalid }: DateTimeFieldProps) {
  const dateField = `${prefix}Date` as const;
  const timeField = `${prefix}Time` as const;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">
        {legend} <span className="font-normal text-muted-foreground">(optional)</span>
      </legend>
      <p className="text-sm text-muted-foreground">{hint} Leave the time empty for the whole day.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={dateField}
          name={dateField}
          type="date"
          value={date}
          onChange={onDate}
          className="h-10 min-w-36 flex-1 sm:w-44 sm:flex-none"
          aria-label={`${legend} date`}
          {...invalid(dateField)}
        />
        <Input
          id={timeField}
          name={timeField}
          type="time"
          value={time}
          onChange={onTime}
          disabled={!date && !time}
          className="h-10 w-36"
          aria-label={`${legend} time`}
          {...invalid(timeField)}
        />
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={onClear}
          className={cn("h-10", !date && !time && "invisible")}
        >
          Clear
        </Button>
      </div>
      {errors}
    </fieldset>
  );
}
