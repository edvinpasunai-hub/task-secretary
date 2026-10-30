-- Stage 6.1: task "Importance" (HIGH / NORMAL / LOW) becomes task "Priority" (HIGH / MEDIUM / LOW).
--
-- It is the same user-set field with a new name and NORMAL renamed to MEDIUM, so nothing is dropped
-- or recreated: each column is converted IN PLACE with an explicit value mapping
--     HIGH -> HIGH     NORMAL -> MEDIUM     LOW -> LOW
-- and then renamed. Every existing row keeps its level. New rows default to MEDIUM.
-- It applies to both columns that use the enum: tasks.importance and recurring_series.importance
-- (the series' value is the template copied into every new occurrence).
--
-- The enum keeps the order HIGH, MEDIUM, LOW, so "ORDER BY priority ASC" still puts HIGH first.
-- Prisma does not run a migration file as one transaction, so it is wrapped in BEGIN / COMMIT:
-- if anything fails, nothing is changed.
BEGIN;

CREATE TYPE "Priority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- tasks
ALTER TABLE "tasks" ALTER COLUMN "importance" DROP DEFAULT;
ALTER TABLE "tasks" ALTER COLUMN "importance" TYPE "Priority"
  USING (CASE "importance"::text WHEN 'NORMAL' THEN 'MEDIUM' ELSE "importance"::text END)::"Priority";
ALTER TABLE "tasks" ALTER COLUMN "importance" SET DEFAULT 'MEDIUM';
ALTER TABLE "tasks" RENAME COLUMN "importance" TO "priority";

-- recurring_series (the template for new occurrences)
ALTER TABLE "recurring_series" ALTER COLUMN "importance" DROP DEFAULT;
ALTER TABLE "recurring_series" ALTER COLUMN "importance" TYPE "Priority"
  USING (CASE "importance"::text WHEN 'NORMAL' THEN 'MEDIUM' ELSE "importance"::text END)::"Priority";
ALTER TABLE "recurring_series" ALTER COLUMN "importance" SET DEFAULT 'MEDIUM';
ALTER TABLE "recurring_series" RENAME COLUMN "importance" TO "priority";

-- Nothing uses the old type any more.
DROP TYPE "Importance";

COMMIT;
