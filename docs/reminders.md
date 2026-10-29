# In-app reminders (Stage 4.4)

A bell in the header shows the number of unread reminders and opens a panel with the reminders that are due.
Nothing is sent outside the app (no email, Telegram or browser push).

## When reminders appear

All times are Europe/Tallinn wall-clock times, whatever time of day the deadline itself has.

- **DAY_BEFORE**: 09:00 on the calendar day before the deadline date.
- **DUE_DAY**: 09:00 on the deadline date.

There is no background job. Reminders are *reconciled* (created when due) when the task list loads and when the
bell loads or refreshes (every minute while a page is open and when the tab becomes visible again). A reminder
missed while the app was closed is therefore created the next time the app opens.

Rules (`src/lib/reminders/rules.ts`):

- A moment that has not come yet creates nothing.
- **No historical reminders**: a deadline in the past creates nothing (overdue tasks are for the later Dashboard stage).
- On the deadline day the day-before reminder is not created (its moment is over); the due-day reminder is.
- A deadline set late (for example for tomorrow, after 09:00 today) is reminded at once.
- Only deadlines of today and tomorrow can need a new reminder, so the reconcile query is tiny.

## Not duplicated, not stale

- `reminders` has `unique(taskId, type, forDueDate)` and creation is `INSERT ... ON CONFLICT DO NOTHING`, so
  repeated loads and simultaneous requests create each reminder exactly once.
- A reminder is shown only while its task is **not completed** and the task's **current deadline date equals the
  deadline date the reminder was made for**. Changing or removing a deadline hides old reminders immediately; the new
  date gets its own. Moving a deadline back to a date that already had reminders does not remind a second time.
- Completing a task hides its reminders; reopening it shows them again with their read state.
  POSTPONED and IN_PROGRESS tasks keep theirs while the deadline is unchanged.
- Once a task's due-day reminder exists, its day-before reminder is replaced by it (one entry per task).
- Read reminders stay in the list (dimmed) and leave it 7 days after they became due.
- Deleting a task or a user deletes their reminders (cascade).

## Read, unread and snoozed

| State | List | Unread badge |
|---|---|---|
| unread (`readAt` empty) | shown | counted |
| read (`readAt` set) | shown, dimmed | not counted |
| snoozed (`snoozedUntil` in the future) | hidden | not counted |

"Remind me in 4 hours" sets `snoozedUntil = now + 4h` and clears `readAt`, so after 4 hours the reminder is visible
and **unread** again. A hidden (snoozed) reminder cannot be changed. Opening a reminder's task link marks it read.
Closing the panel keeps it closed; new reminders only change the badge.

## Isolation

Server Actions resolve the user from the session and accept only a reminder id; every write has the owner in its
`WHERE`. The database also enforces it: `reminders (taskId, userId)` is a composite foreign key to `tasks (id, userId)`.

## Recurring tasks

Each instance is a separate task with its own deadline, so it has its own reminders. A finished instance's reminders
are hidden; the successor gets its own when its dates arrive. Stopping a series does not touch existing reminders.

## Migration

`20261029160000_reminders`: adds `readAt`, the unique key `tasks(id, userId)`, the composite foreign key and the
index `reminders(userId, scheduledAt)`.

## Not in this stage

Overdue-task handling (Dashboard), task deletion/trash (4.5: soft-deleted tasks must also hide their reminders),
per-user reminder times or time zones, other channels.
