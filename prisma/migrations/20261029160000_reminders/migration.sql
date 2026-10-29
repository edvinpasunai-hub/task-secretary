-- Stage 4.4: in-app reminders.
-- Adds the read state, makes the database enforce "a reminder belongs to the same user
-- as its task", and indexes the lookup the notification bell uses.
-- Wrapped in one transaction (Prisma does not run a migration file as one).
BEGIN;

-- The (taskId, userId) pair of a reminder must match a task's (id, userId).
-- Needs a unique key on the referenced columns.
CREATE UNIQUE INDEX "tasks_id_userId_key" ON "tasks"("id", "userId");

-- Replace the plain task key with the composite one (still deletes reminders with their task).
ALTER TABLE "reminders" DROP CONSTRAINT "reminders_taskId_fkey";
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_taskId_userId_fkey" FOREIGN KEY ("taskId", "userId") REFERENCES "tasks"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Read state: NULL = unread. "Remind Later" sets it back to NULL.
ALTER TABLE "reminders" ADD COLUMN "readAt" TIMESTAMP(3);

-- The bell looks up one user's reminders by time; this index replaces the plain userId one.
DROP INDEX "reminders_userId_idx";
CREATE INDEX "reminders_userId_scheduledAt_idx" ON "reminders"("userId", "scheduledAt");

COMMIT;
