# Secretary's Focus

## Purpose
A short, ordered list of the tasks the user should work on next. It answers "what should I do now?" without the user having to read every dashboard section.

## Position
The first section of the signed-in Dashboard, directly under the greeting and the Add task button and above the Daily briefing and all task sections. Title: **Secretary's Focus**, subtitle: "Recommended tasks to focus on next".

## How it uses the ranking engine
Focus does not score anything itself. `loadDashboard` (`src/lib/dashboard/queries.ts`) calls the Stage 6.2 `loadRankedTasks` with the user's id, time zone and the same "now" as the rest of the dashboard, then `toFocusItems` (`src/lib/ranking/focus.ts`) keeps the first five results. Scoring rules and tie-breaks are documented in `ranking.md` and are unchanged. Scores are never stored and never shown; a Focus row only carries rank, id, title, priority, due text and reason.

## Eligibility and limit
Eligibility is decided by the ranking engine: active, not completed, not archived, not trashed, no tombstones, and only the signed-in user's tasks. At most **five** rows are shown.

## Row contents
Rank (1-5), title (links to `/tasks/<id>?from=dashboard`), priority as text (High / Medium / Low), due information ("Overdue since Mon, 9 Nov", "Due today", "Due tomorrow", "Due Fri, 13 Nov", "No due date", with the time when set) and one short reason. Everything is text, not colour alone.

## Rule-based explanations
`explainRecommendation` is a pure function of the ranking breakdown (priority, urgency level, age in days, days until due). It never uses list position and no AI is involved. Examples: "High priority and overdue", "Overdue and needs attention", "High priority and due today", "High priority, due tomorrow", "Due in 2 days", "Waiting for 30+ days", "Medium priority, no due date". A task without a due date is never called overdue; "tomorrow" is only used for the next calendar day.

## Completion and refresh
Each row has a check button that submits the existing `setTaskStatus` action (same authorization, recurrence handling and validation as every other completion). The action refreshes the page, so the task leaves Focus, the next ranked task takes its place and the Daily briefing counters update in the same render. Focus is recomputed on every Dashboard render in the user's time zone. There is no polling, background job or client timer; the existing day-rollover refresh handles midnight. Other changes (postpone, trash, restore, edit) show up on the next render.

## Empty and partial states
- Five or more eligible tasks: exactly five rows.
- One to four: only those rows, no placeholders.
- None: "You're all caught up. No tasks need your attention right now." with an Add task link (`/tasks/new?from=dashboard`).

## Security and ownership
Only the signed-in user's tasks are read (the user id comes from the session). Task titles and scores never appear in URLs; the only parameter is `from=dashboard`. Completion is authorized server-side by the existing action.

## Known limitations
- When clocks go back, the repeated hour can rank a time-based task slightly off (inherited from Stage 6.2, see `ranking.md`).
- Updates are refresh-based: Focus changes after an action or a page refresh, not live, and across midnight only on the next request or day-rollover refresh.
- A Focus task also appears in its normal dashboard section.
