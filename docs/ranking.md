# Task ranking engine (Stage 6.2)

A deterministic, server-side ranking of a user's open tasks. It is a pure module (`src/lib/ranking/ranking.ts`):
no database, no clock of its own, no randomness and nothing stored (there is no score column). Stage 6.3
(Secretary's Focus) consumes it. No page uses it yet: the dashboard and the Tasks page keep their own ordering, and
no score is shown anywhere.

## Score

`score = priority points + due-date urgency points + age points` (age only for tasks without a due date)

| Part | Rule | Points |
|---|---|---|
| Priority | High / Medium / Low | +50 / +25 / +0 |
| Due date | overdue | +60 |
| | due today | +40 |
| | due tomorrow | +25 |
| | due in 2-3 calendar days | +15 |
| | due later | +0 |
| Age (no due date only) | under 7 days / 7-13 / 14-29 / 30-59 / 60+ | +0 / +5 / +10 / +15 / +20 |

Highest possible: 110 (High and overdue); without a due date: 70 (High and 60+ days old).

## Rules

- **Who is ranked:** active, unfinished tasks only. Finished, archived and trashed tasks (and the scrubbed "tombstone"
  rows of permanently deleted occurrences) are left out. `rankTasks` checks this itself, and `loadRankedTasks`
  (`src/lib/ranking/queries.ts`) also loads only the owner's active tasks.
- **Overdue** is the application's existing time-aware rule (`classifyTask` / `isOverdue`, the one the Overdue badge and
  the dashboard use): a timed deadline once its minute has passed, a date-only deadline after the end of its day.
  So a task due today at 09:00 scores as overdue (+60) from 09:01, and as due today (+40) before that.
- **Days are calendar days in the user's time zone** (the saved zone, default Europe/Tallinn; the module takes the zone
  as a parameter and never hard-codes it). Dates are compared with the same integer calendar arithmetic as the
  dashboard, so the 23-hour day (29 Mar 2026) and the 25-hour day (25 Oct 2026) are exact and "tomorrow" is always the next
  calendar day.
- **Age** is the number of calendar days from the day the task was created (`createdAt`, in the user's zone) to
  today. Editing, status changes, postponing, trashing/restoring and archiving never change `createdAt`, so they never
  reset it. A new occurrence of a repeating task is a new task with its own `createdAt`.
- **Order** (a strict total order, so nothing is left to chance): higher score; earlier due date and time (a date-only
  deadline counts as the end of its day, no due date last); higher priority; older task; task id.

## Using it

```ts
import { rankTasks } from "@/lib/ranking/ranking";
const ranked = rankTasks(tasks, { now: new Date(), timeZone: user.timeZone });
// [{ task, rank: 1, score: 110, breakdown: { priority, urgency, urgencyLevel, age, ageDays } }, ...]
```

`breakdown` explains each score (for tests, and for Stage 6.3's explanations). On the server, `loadRankedTasks({ userId,
timeZone, now })` does the loading and ranking.

## Notes

- With these point values the priority tie-breaker (third) can never decide on its own: two tasks with the same due
  date have the same urgency, so equal scores imply equal priority, and without a due date a priority step (25) is larger
  than the biggest age bonus (20). It is kept because the specification lists it and it protects against future changes
  to the table; it is tested directly.

## Known limitation: the repeated hour when the clocks go back

When the clocks go back (Europe/Tallinn: 25 October 2026, 04:00 summer time becomes 03:00 winter time) the wall-clock
hour 03:00-03:59 happens twice. The application compares a TIMED deadline with "now" by wall-clock minute (the same
`isOverdue` / `classifyTask` rule used by the Overdue badge and the dashboard), so a timed deadline inside that hour can
briefly change between overdue (+60) and due today (+40) while the hour repeats, and its rank can change with it. It
settles as soon as the second pass of that hour is over. Date-only deadlines are not affected, and neither are the day
boundaries themselves (the 25-hour day is handled exactly). This stage deliberately does not change the existing date
behavior; if the application ever compares deadlines by real instants, the ranking will follow automatically because
it reuses that rule.
