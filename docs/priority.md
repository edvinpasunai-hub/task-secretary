# Task priority (Stage 6.1)

A task has a user-set **priority**: High, Medium or Low (default Medium). It replaces the earlier "Importance"
field (High / Normal / Low): it is the same field with a new name, and Normal is now called Medium.

Stage 6.1 only stores, edits and shows the priority. It does not change by itself, has no score, and nothing
(besides the existing ordering) uses it yet; ranking, "Secretary's Focus" and advice come in later Stage 6 steps.

## Database

`tasks.priority` and `recurring_series.priority` (the template for new occurrences), type `Priority`
(`HIGH`, `MEDIUM`, `LOW`, in that order, so `ORDER BY priority` puts HIGH first), `NOT NULL DEFAULT 'MEDIUM'`.

Migration `20261030120000_task_priority` converts the existing columns IN PLACE, no drop and no recreate:

    HIGH -> HIGH     NORMAL -> MEDIUM     LOW -> LOW

so every existing task and series keeps its level, and anything created before without a choice (old default
NORMAL) becomes MEDIUM. It runs in one transaction, so a failure changes nothing. No constraint or index depended on
the old column. `tests/integration/priority-migration.test.ts` proves all of this on a scratch database that
holds old-schema data (every value, every status, trashed, archived, repeating, reminders, two users).

## Where it appears

- Add / Edit form: a "Priority" group (High, Medium, Low; Medium preselected). The field is named `priority`.
- Cards and the task page: a badge "High priority" / "Medium priority" / "Low priority" (text, not only colour;
  High keeps its flag icon and the card's accent bar). The dashboard uses the same card.
- Ordering (unchanged rule): the Tasks list sorts by priority first; the dashboard sorts each section by due date,
  then priority.

## Validation and safety

The server accepts only `HIGH`, `MEDIUM`, `LOW` (the old value `NORMAL`, other text, an empty or missing value, or
the old field name `importance` from a stale page are refused with "Please choose High, Medium or Low." and nothing is
saved). The database also refuses any other value. Ownership checks are unchanged: only the owner's active task is
found, so a swapped task id changes nothing. A priority never appears in a URL (the add/edit pages drop every query
parameter except `from`, `category` and `due`).

## Repeating tasks

The series stores the priority as part of its template, exactly as it already did for importance (no new rules):

- A new occurrence copies the series template.
- Creating a repeating task, or turning an ordinary task into a repeating one, puts its priority in the template.
- **Only this task**: changes that one occurrence only. The template, the series version and all other occurrences
  stay as they are, and the NEXT occurrence still copies the template.
- **This and future tasks**: the existing version-checked series update changes the template and every unfinished
  occurrence. Finished occurrences are not touched. Only changed fields are sent, so changing something else does
  not overwrite an occurrence's own priority.
- Postponing, trashing, restoring and archiving never change a priority; a permanently deleted occurrence's tombstone
  is scrubbed to Medium (it keeps no user data).
