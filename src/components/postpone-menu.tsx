"use client";

import { CalendarClock, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";

import { postponeTaskAction } from "@/app/tasks/postpone-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatLocalDate, type LocalDate } from "@/lib/local-time";
import { postponeOptions, postponeProblem, POSTPONE_LABELS, POSTPONE_MESSAGES } from "@/lib/postpone-rules";

// A compact "Postpone" menu: Tomorrow, In 3 days, Next week, or Choose date. Only choices that really
// move the deadline later than it is now (and after today) are offered; the server checks everything
// again. `today` and `deadlineDate` are the user's local dates, worked out on the server, and
// `deadlineDate` is sent back so a stale page is refused instead of overwriting a newer change.
export function PostponeMenu({ taskId, title, deadlineDate, today }: { taskId: string; title: string; deadlineDate: LocalDate; today: LocalDate }) {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);
  const { options, earliest, latest } = postponeOptions(today, deadlineDate);
  // A choice that would not move the deadline later is not offered; say so, so a missing choice is not a mystery.
  const someHidden = options.length < Object.keys(POSTPONE_LABELS).length;

  // Never reappear open after Next.js hides and restores the page.
  useLayoutEffect(() => () => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onClick = (event: MouseEvent) => root.current && !root.current.contains(event.target as Node) && close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setChoosing(false);
    setError(null);
  }

  function postpone(newDate: string) {
    const problem = postponeProblem(newDate, today, deadlineDate);
    if (problem) {
      setError(POSTPONE_MESSAGES[problem]);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await postponeTaskAction({ taskId, newDate, expectedDeadlineDate: deadlineDate });
      if (result.ok) close();
      else setError(result.message);
    });
  }

  return (
    <div ref={root} className="relative" data-postpone-menu>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-9"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Postpone “${title}”`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <CalendarClock aria-hidden />
        Postpone
      </Button>

      {open && (
        <div role="menu" aria-label="Postpone to" className="absolute left-0 top-full z-30 mt-1 flex w-60 flex-col gap-1 rounded-xl border bg-card p-1.5 shadow-lg" data-postpone-panel>
          {options.map((option) => (
            <Button key={option.choice} type="button" role="menuitem" variant="ghost" size="lg" className="h-9 justify-between" disabled={pending} onClick={() => postpone(option.date)} data-postpone-option={option.choice}>
              {option.label}
              <span className="text-xs font-normal text-muted-foreground">{formatLocalDate(option.date).replace(/ \d{4}$/, "")}</span>
            </Button>
          ))}
          {!choosing ? (
            <Button type="button" role="menuitem" variant="ghost" size="lg" className="h-9 justify-start" disabled={pending} onClick={() => setChoosing(true)} data-postpone-option="custom">
              Choose date…
            </Button>
          ) : (
            <form
              method="post"
              noValidate
              className="flex flex-col gap-2 p-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                postpone(date);
              }}
            >
              <Input type="date" aria-label="New deadline date" value={date} min={earliest} max={latest} onChange={(event) => setDate(event.target.value)} className="h-9" autoFocus />
              <Button type="submit" size="lg" className="h-9" disabled={pending || date === ""}>
                {pending && <LoaderCircle className="animate-spin" aria-hidden />}
                Postpone
              </Button>
            </form>
          )}
          {someHidden && (
            <p className="px-2 pb-1 text-xs text-muted-foreground" data-postpone-hint>
              Only days after the current deadline ({formatLocalDate(deadlineDate)}) are offered.
            </p>
          )}
          {error && (
            <p role="alert" className="px-2 py-1 text-sm text-destructive" data-postpone-error>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
