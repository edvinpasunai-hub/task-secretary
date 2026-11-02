# Secretary's Advice

Advice is not a separate dashboard section. It is part of **Secretary's Focus** (see `focus.md`): a short note under a Focus task, and one general warning at the bottom of the Focus section. It is rule-based and deterministic (no AI, no external service) and nothing it produces is stored.

## Postponement advice (under a Focus task)
Uses the existing persisted counter `rescheduleCount` (the number of times the deadline date was moved after it was first set, by postponing or editing). Nothing new is counted and the counting rules are unchanged.

| Count | Advice |
|---|---|
| 0-2 | none |
| 3-4 | "You've postponed this task N times. Consider setting aside time for it." |
| 5 or more | "Postponed N times. Consider breaking this task into smaller steps or revisiting its deadline." |

N is the real count. Advice is shown only for the (at most five) tasks currently in Focus, below the ranking reason, in small muted text with a neutral icon and a hidden "Advice:" prefix for screen readers. The ranking reason is never replaced. The advice never changes a task, rank or score, and nothing is edited or created automatically.

## Overload warning (bottom of Focus)
When **8 or more** eligible tasks are overdue or due today, one calm note is shown at the bottom of the Focus section:

> **A busy day ahead**
> You have N tasks overdue or due today. Consider choosing a few to focus on first.

7 or fewer: nothing. 8 or more: exactly one note, with the actual N.

## Eligibility and counting
- The count covers ALL eligible tasks of the signed-in user, not only the five shown. It is read from the same Stage 6.2 ranking that Focus uses (`loadRankedTasks`, no extra query): a task counts when its urgency level is OVERDUE or TODAY. Each task has exactly one level, so nothing is counted twice, and the count always equals the Daily briefing's "Overdue" plus "Due today".
- Eligible means active and unfinished: completed, archived and trashed tasks, and deleted or tombstoned recurring occurrences, are excluded. Tomorrow, later and no-due-date tasks do not count.
- "Overdue" and "today" use the existing Stage 6.2 rules in the user's time zone (a timed deadline that has passed is overdue; a date-only deadline is due until the end of its day).

## Refresh behaviour
Advice is recomputed on every Dashboard render together with Focus. Completing a task from Focus refreshes the page; postponing, trashing, archiving, restoring or editing a task updates it at the next render (the existing revalidation). There is no polling, background job or new timer; across midnight the existing day-rollover refresh applies.

## Security and privacy
- Everything is computed for the authenticated user only (the user id comes from the session); other users' tasks cannot influence the count or the advice.
- No titles, counts or advice text appear in URLs or logs.
- Nothing is written to the database: no advice, count or score is stored, and there is no migration.

## Known limitations
- The counter also counts deadline changes made by editing a task, not only the Postpone action.
- The repeated hour when clocks go back can affect a time-based "overdue" check (inherited from Stage 6.2).
- Updates are refresh-based, not live.
- A recurring task's next occurrence starts with its own counter at 0, so repeated postponement of earlier occurrences does not carry over.
