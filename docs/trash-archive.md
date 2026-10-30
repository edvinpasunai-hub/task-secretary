# Trash and Archive (Stage 4.5)

## Where a task is

| State | Columns | Shown in |
|---|---|---|
| active | `deletedAt` and `archivedAt` empty | task list, categories, reminders |
| archived | `archivedAt` set | Archive page (view-only) |
| in Trash | `deletedAt` set | Trash page, for 30 days |
| tombstone | `purgedAt` set (and `deletedAt`) | nowhere |

`src/lib/task-state.ts` has the shared filters. Every query that finds a task to show or change starts from
`ACTIVE_TASK` (an archived task may also be *viewed*: `VIEWABLE_TASK`).

- **Archive** is for finished tasks only (the app and a database CHECK enforce it, so Undo Complete can never reach an
  archived task: restore it first). Archived tasks keep their history, category, series link and dates.
- A task can be moved to Trash from the archive; restoring it returns it to the archive.
- Trashed tasks cannot be opened. Archived tasks open read-only with a Restore button.
- Category task counts count active tasks only. Trash/archive never change a task's category.

## 30-day retention

A task moved to Trash at `D` is restorable while `now < D + 30 days` and expired when `now >= D + 30 days`
(exactly 30 x 24 hours on the UTC timeline, so clock changes cannot move the boundary; `src/lib/trash/rules.ts`).

- **Restore** is one conditional update that includes the age check (`deletedAt > now - 30 days`), so an expired task can
  never be restored, even before it is physically deleted. The Trash page also never lists expired tasks.
- **Cleanup** runs for the logged-in user when the task list, Trash or Archive page loads (no scheduler). It deletes
  the oldest expired tasks first: up to 200 per pass, up to 10 passes per visit; what is left is handled by the next visit.
  Each task is removed in its own transaction by a conditional delete, so repeating or running it concurrently is safe,
  and it only ever touches the given user's tasks. Reminders are deleted by the existing cascade.
- The Trash page shows when each task is deleted for good and the days left.
- **Empty Trash** and **Delete permanently** need a confirmation.

## Recurring tasks

All operations on a task of a series take the recurrence engine's per-series advisory lock first, then use conditional
updates. The database constraints stay the backstop: `unique(seriesId, occurrenceKey)` and `unique(predecessorId)`.

- **Only this task**: moving one occurrence to Trash *skips* it. A trashed tail counts as finished, so an active series
  immediately creates the next occurrence (the engine's `ensureNext`, the same code as completing it); a paused series
  creates it when resumed. The series is untouched and keeps repeating. Restoring brings back an ordinary unfinished
  task (not the tail, so nothing duplicates).
- **This and future tasks**: stops the series for good (version-checked, same terminal state as Repeat -> Never) and
  moves every unfinished task of it to Trash, after an explicit confirmation that says it cannot be resumed.
  Completed history stays. Restoring a task of a stopped series does not restart the series.
- **Permanent deletion never recreates an occurrence.** The engine creates the next occurrence after the latest
  occurrence key it can see. If the tail row of a series that could still generate (active, paused or ended) were
  simply deleted, the previous task would become the tail and a future date could be generated again. So that one row
  is kept as a **tombstone**: scrubbed of everything except
  `id`, `userId`, `seriesId`, `occurrenceKey` (a date) and technical timestamps (`createdAt`, `updatedAt`, `deletedAt`,
  `purgedAt`), with `status = COMPLETED`, `priority = MEDIUM`, `rescheduleCount = 0` and an empty title (the schema
  requires a value). Title, description, category, all dates and deadlines, estimate, completion time, predecessor link
  and its reminders are removed. A tombstone is never listed, searched, restored, archived or shown by reminders (it is
  always "deleted"), and an old tombstone is dropped once a later instance exists. A stopped series generates nothing,
  so its tasks are deleted for real, and the empty series row goes with the last one.

## Reminders

Trashed and archived tasks neither get nor show reminders (reconcile, list, mark-read and snooze all require an active,
unfinished task). Reminder rows are kept while a task is in Trash, so read and snooze state survive a restore.
**Restore removes that task's reminders whose deadline date has already passed** (no obsolete reminders come back);
reminders for today or later stay, and normal reconcile creates what is now due (the existing unique key prevents
duplicates). The bell follows trash/archive/restore immediately because those actions refresh the page.

## Migration

`20261030090000_trash_archive`: adds `deletedAt`, `archivedAt`, `purgedAt`, the two CHECK constraints (archived only if
completed; a tombstone is always a deleted, completed task of a series) and the index `(userId, deletedAt, archivedAt)`.
