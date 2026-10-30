"use client";

import { LoaderCircle, Repeat } from "lucide-react";
import { useState, useTransition } from "react";

import { pauseSeriesAction, resumeSeriesAction, setSeriesEndDateAction, type SeriesActionResult } from "@/app/tasks/series-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeRepeat, describeState } from "@/lib/recurrence/describe";
import type { SeriesView } from "@/lib/recurrence/types";

type Mode = "idle" | "pause" | "end";

// What the task page shows about a repeating series, with the three controls that
// are not part of editing a task: pause, resume and the end date.
// `next` is the date of the next task that will be created, worked out on the
// server (nothing is created by showing it).
export function SeriesPanel({ series, next }: { series: SeriesView; next: string | null }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SeriesActionResult | null>(null);
  const [until, setUntil] = useState("");
  const [endDate, setEndDate] = useState(series.endDate ?? "");

  const stopped = series.state === "STOPPED";

  function run(action: () => Promise<SeriesActionResult>) {
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) setMode("idle");
    });
  }

  const base = { seriesId: series.id, version: series.version };

  return (
    <section aria-labelledby="repeat-panel-heading" className="mt-6 rounded-xl border bg-card p-4 shadow-xs" data-series-panel>
      <h2 id="repeat-panel-heading" className="flex items-center gap-2 text-sm font-medium">
        <Repeat className="size-4 text-primary" aria-hidden />
        Repeat
      </h2>
      <p className="mt-2 text-sm" data-series-summary>
        <span className="font-medium">{describeRepeat(series)}</span>
        <span className="text-muted-foreground"> · {describeState(series.state, series.pausedUntil)}</span>
      </p>
      {next && series.state === "ACTIVE" && (
        <p className="mt-1 text-sm text-muted-foreground" data-series-next>
          Next new task after the current one: {next}
        </p>
      )}
      {stopped && <p className="mt-1 text-sm text-muted-foreground">Repeating was turned off, so no new tasks are created.</p>}

      {series.state === "ACTIVE" && (
        <p className="mt-1 text-sm text-muted-foreground">
          Pausing is a temporary break you can resume. To stop for good, set Repeat to “Never” when editing the task.
        </p>
      )}
      {!stopped && (
        <div className="mt-3 flex flex-wrap gap-2">
          {series.state === "PAUSED" ? (
            <Button variant="outline" size="lg" className="h-9" disabled={pending} onClick={() => run(() => resumeSeriesAction(base))}>
              Resume repeating
            </Button>
          ) : (
            series.state === "ACTIVE" && (
              <Button variant="outline" size="lg" className="h-9" disabled={pending} aria-expanded={mode === "pause"} onClick={() => setMode(mode === "pause" ? "idle" : "pause")}>
                Pause repeating
              </Button>
            )
          )}
          <Button variant="outline" size="lg" className="h-9" disabled={pending} aria-expanded={mode === "end"} onClick={() => setMode(mode === "end" ? "idle" : "end")}>
            {series.endDate ? "Change end date" : "Set end date"}
          </Button>
        </div>
      )}

      {mode === "pause" && (
        <form
          method="post"
          className="mt-3 flex flex-col gap-2 rounded-lg bg-muted/50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => pauseSeriesAction({ ...base, until: until || null }));
          }}
        >
          <Label htmlFor="pause-until">
            Pause until <span className="font-normal text-muted-foreground">(optional; leave empty to pause until you resume)</span>
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input id="pause-until" type="date" value={until} onChange={(event) => setUntil(event.target.value)} className="h-10 w-48" />
            <Button type="submit" size="lg" className="h-10" disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" aria-hidden />}
              Pause
            </Button>
          </div>
        </form>
      )}

      {mode === "end" && (
        <form
          method="post"
          className="mt-3 flex flex-col gap-2 rounded-lg bg-muted/50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => setSeriesEndDateAction({ ...base, endDate: endDate || null }));
          }}
        >
          <Label htmlFor="series-end-date">Last day a task can fall on (inclusive)</Label>
          <div className="flex flex-wrap gap-2">
            <Input id="series-end-date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="h-10 w-48" />
            <Button type="submit" size="lg" className="h-10" disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" aria-hidden />}
              Save
            </Button>
            {series.endDate && (
              <Button type="button" variant="outline" size="lg" className="h-10" disabled={pending} onClick={() => run(() => setSeriesEndDateAction({ ...base, endDate: null }))}>
                Remove end date
              </Button>
            )}
          </div>
        </form>
      )}

      {result && (
        <p role={result.ok ? "status" : "alert"} className={`mt-3 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-muted text-foreground" : "bg-destructive/10 text-destructive"}`} data-series-result>
          {result.message}
        </p>
      )}
    </section>
  );
}
