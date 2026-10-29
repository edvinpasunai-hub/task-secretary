-- Stage 4.5: Trash and Archive.
-- deletedAt  = moved to Trash (recoverable for 30 days, then physically deleted by the app).
-- archivedAt = archived (only finished tasks).
-- purgedAt   = a "tombstone": a permanently deleted occurrence of a recurring series, scrubbed of all
--              content and kept only so that its date can never be generated again.
-- Wrapped in one transaction (Prisma does not run a migration file as one).
BEGIN;

ALTER TABLE "tasks"
  ADD COLUMN "deletedAt"  TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "purgedAt"   TIMESTAMP(3);

-- Only finished tasks can be archived.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_archived_only_completed_check"
  CHECK ("archivedAt" IS NULL OR "status" = 'COMPLETED');

-- A tombstone is always a deleted, finished task of a series.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_purged_tombstone_check"
  CHECK ("purgedAt" IS NULL OR ("deletedAt" IS NOT NULL AND "status" = 'COMPLETED' AND "seriesId" IS NOT NULL));

CREATE INDEX "tasks_userId_deletedAt_archivedAt_idx" ON "tasks"("userId", "deletedAt", "archivedAt");

COMMIT;
