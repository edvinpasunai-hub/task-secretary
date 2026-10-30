# Dashboard (Stage 5)

`/` is the dashboard (the page after login). The Tasks list moved to `/tasks` and keeps all its features
(category filter, completed section, status buttons). `/tasks/[id]`, `/tasks/new`, Categories, Archive and Trash
keep their routes. No database change was needed.

## What it shows

- A time-of-day greeting from the user's local hour (05-11 morning, 12-17 afternoon, 18-21 evening, 22-04 night),
  with the first name, and today's date.
- An always-visible **Daily briefing**: a sentence plus four counters (due today, overdue, upcoming 7 days,
  completed today). The counters are full totals, never limited to the five tasks shown.
- Sections **Overdue**, **Today**, **Upcoming** and **No due date**: at most 5 tasks each, with the full count and
  a "View all" link. A compact **Later (N)** link sits next to Upcoming.
- The existing task card (status, importance, timing, repeat and category badges), the reminder bell, and an
  Add task button.

## One rule for every list

`src/lib/dashboard/sections.ts` decides the section of a task. The dashboard AND the Tasks-page filter
(`/tasks?due=overdue|today|upcoming|later|none`) use it, so "View all" shows exactly what was counted, in the same order.

- Only the **deadline** counts. A planned date without a deadline is "No due date".
- **Overdue** is the existing time-aware rule (`isOverdue`): a timed deadline once its minute has passed, a
  date-only deadline after the end of its day. A task due today at 09:00 is in Today until 09:00, then Overdue.
- **Today**: deadline today, not yet overdue. **Upcoming**: the next 7 calendar days, not today. **Later**: further away.
- Completed tasks are in no section; every unfinished task is in exactly one.
- Trashed and archived tasks are excluded everywhere (the shared active-task filter).
- Sorting: earliest deadline first (a date-only deadline sorts after timed ones of that day), then importance, then
  age; "No due date" by importance, then age.
- The user's saved time zone (default Europe/Tallinn) decides "today" and every boundary. Calendar days are added
  with integer date maths, so clock changes cannot shift the 7-day window.

## Completed today

`status = COMPLETED` and `completedAt` inside the user's current local day, measured as [start of today, start of
tomorrow) in real time, so 23-hour and 25-hour days are exact. Archived tasks still count, tasks in Trash do not, a
reopened task stops counting (its `completedAt` is cleared), and each completed occurrence of a repeating task counts
separately.

## Repeating tasks

Every open occurrence is one task, in the section of its own deadline. The dashboard does not invent future
occurrences: the next one appears when the current one is completed (the existing "tail" rule). A paused series'
open task is shown with its Paused badge.

## Quick actions

- **Complete**: the existing status action (a repeating task creates its next occurrence as before). The page
  refreshes, so counts, sections and the bell update at once.
- **Postpone** (menu: Tomorrow, In 3 days, Next week, Choose date): `src/lib/postpone.ts`.
  - Tomorrow = next calendar day, In 3 days = three calendar days from today, Next week = the next Monday
    (a week later when today is Monday), all in the user's time zone.
  - It only moves the **deadline date**: a timed deadline keeps its time, a date-only deadline stays date-only.
  - The new date must be after today and later than the current deadline (the menu only offers those; the server
    checks again). Dates past 10 years or invalid are refused.
  - It uses the existing deadline rule (`applyDeadlineChange`): the reschedule count and the original deadline
    behave exactly as when the deadline is edited by hand, and the status becomes Postponed.
  - Reminders follow the deadline automatically (old ones hide, the new date gets its own).
  - A repeating task: only that occurrence moves. The occurrence key, series rule, version and other tasks are
    untouched; the next occurrence still follows the series rule.
  - Stale-safe: the request carries the deadline the user saw and is one conditional update, so a stale page or two
    simultaneous requests apply at most once. Only the owner's active, unfinished task is found.
- **Add task**: a button to the existing form.

## Where "back" leads

A task opened from the dashboard returns to it after Save, Cancel, Back and Move to Trash; opened from the Tasks list
it returns there with its filters (`category`, `due`). The link carries only short validated values
(`?from=dashboard`, `?category=<id>&due=<section>`); the destination is built on the server by
`src/lib/return-path.ts` and is always a fixed local path. A category must be one of the user's own. Anything
unknown or malicious falls back to `/tasks`, so open redirects are impossible by construction.

## Day rollover

A dashboard left open past midnight re-reads its data when the local date changes (checked once a minute and when
the tab becomes visible).
