# Recurring tasks: design notes (Stages 4.3.1 and 4.3.2)

Backend only. There is no recurring-task UI yet. Code: `src/lib/recurrence/`.
Tests: `tests/unit` (pure) and `tests/integration` (real PostgreSQL, separate test database).

## Model

- `RecurringSeries` holds the schedule and the **template** (title, description, importance,
  duration, category, deadline rule). It is independent of its tasks.
- A task (instance) has `seriesId`, `occurrenceKey` (the scheduled occurrence, e.g. `2026-11-09`
  or `2026-11-09T09:00`, never changed by postponing) and `predecessorId` (the instance whose
  completion created it).
- "Manually postponed" is derived: the task's planned date/time differs from its occurrence key.
- Recurrence is anchored to the **planned date**. Deadline = planned date + N calendar days at an
  optional wall-clock time (never elapsed hours, so daylight saving cannot move it).
- Everything is in `Europe/Tallinn`. Date-only series use plain calendar arithmetic; timed series keep
  their wall-clock time (a time that does not exist on a clock-change day is ordered as if shifted
  forward by the gap; one that happens twice means its first occurrence).

## Rules

- **Successor**: created when the **tail** instance (greatest occurrence) is completed while the series
  is ACTIVE. It is the first occurrence strictly after `max(completed occurrence, now)`: schedule is
  fixed, missed occurrences are skipped, early completion moves forward, a date-only series never
  picks the same date. Completing any older instance (for example after Undo Complete) creates nothing.
- **States**: ACTIVE, PAUSED (indefinitely or until a date), ENDED (inclusive end date reached;
  reversible by extending it), STOPPED (recurrence turned off; final).
- Resume / expired pause / extended end date create the nearest FUTURE occurrence, and only if the tail
  is completed. Expired pauses are reconciled on task-list load and at the start of every series
  operation (no background job).
- Disabling recurrence stops the series, detaches the current task (keeps its predecessor link) and
  keeps completed history linked to the stopped series.

## Concurrency

One transaction per operation, a per-series advisory lock, a conditional "claim" for completion,
`ON CONFLICT DO NOTHING` inserts, and database constraints as the last line of defence
(`unique(seriesId, occurrenceKey)`, `unique(predecessorId)`, composite same-user key, CHECKs).
Series edits are version-checked (typed `CONFLICT` result with `currentVersion`).

## Stage 4.3.2: user interface and edit behaviour

- **Add Task** has a "Repeat" section. One click creates the task and its series in a single
  transaction (`createRecurringTask`); any failure rolls back both. Repeating needs a planned date.
- **Time of day** is the task's planned time (empty = date-only). A series can switch between
  date-only and timed in both directions in the backend (`updateSeries` / `updateTaskAndSeries`),
  not only in the UI. A date-only occurrence inside a timed series counts as 23:59 of its day when the
  next occurrence is computed, so a switch never creates a second occurrence on the same day. A task
  that keeps an older time can still be followed by a later occurrence on the same day with the new time.
- **Edit scope** (tasks that repeat):
  - *Only this task* saves this task row only. The repeat settings are locked, the series template and
    all other tasks are untouched. Moving only the planned date is a postponement of this task, not a rule change.
  - *This and future tasks* uses the version-checked series update. Only **changed** fields are sent,
    so individual edits made earlier to other unfinished tasks are not overwritten. The deadline rule
    changes only if a deadline field was changed.
  - Repeat -> Never needs *This and future tasks*: the series is stopped (terminal), this task becomes
    ordinary and keeps its predecessor link. An ordinary task set to repeat is converted in the same
    transaction as its edit.
  - Completed tasks (and stopped series) are read-only for repeat settings; no scope choice is shown.
  - The form remounts when the series version changes; stale saves return a friendly "changed elsewhere" message.
- The task page shows a series panel (summary, next task, pause/resume, end date). No separate page,
  calendar or reminders.

## Deferred

- **Calendar/forecast view** of future occurrences.

- **Stage 4.5 (trash/archive)**: deleting one instance or a whole series. `stopSeries` is the
  non-destructive building block. Soft-deleted instances must keep reserving their occurrence key, and
  deleting the tail instance must advance or end the series (decision needed then).
- Per-user recurrence time zone (the engine already takes a time-zone parameter).
- Re-dating other unfinished instances when the schedule changes (currently only the edited one moves).
- Reminders for recurring tasks.

## Testing note

The development database server's own clock is `Europe/Kiev`. Application writes go through Prisma
(UTC); raw SQL that relies on column defaults would store server-local time. Tests that insert rows
with raw SQL must write explicit UTC timestamps.
