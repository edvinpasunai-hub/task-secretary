-- Stage 4.3.1: recurring tasks.
--
-- This file is wrapped in an explicit transaction ON PURPOSE. Prisma runs the
-- statements of a migration file one at a time, so without BEGIN/COMMIT a
-- failure part-way through would leave the database half-migrated. With it, the
-- migration either applies completely or not at all.
-- Rule: COMMIT must stay the very last statement; nothing may follow it.
BEGIN;

-- CreateEnum
CREATE TYPE "RecurrenceType" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_WEEKDAYS');

-- CreateEnum
CREATE TYPE "SeriesState" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED', 'STOPPED');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "occurrenceKey" TEXT,
ADD COLUMN     "predecessorId" TEXT,
ADD COLUMN     "seriesId" TEXT;

-- CreateTable
CREATE TABLE "recurring_series" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "RecurrenceType" NOT NULL,
    "weekdays" INTEGER[],
    "monthlyDay" INTEGER,
    "anchorDate" DATE NOT NULL,
    "plannedTime" TIME(0),
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "importance" "Importance" NOT NULL DEFAULT 'NORMAL',
    "estimatedMinutes" INTEGER,
    "categoryId" TEXT,
    "deadlineOffsetDays" INTEGER,
    "deadlineTime" TIME(0),
    "endDate" DATE,
    "state" "SeriesState" NOT NULL DEFAULT 'ACTIVE',
    "pausedUntil" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_series_userId_state_pausedUntil_idx" ON "recurring_series"("userId", "state", "pausedUntil");

-- CreateIndex
CREATE INDEX "recurring_series_categoryId_idx" ON "recurring_series"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_series_id_userId_key" ON "recurring_series"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_predecessorId_key" ON "tasks"("predecessorId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_seriesId_occurrenceKey_key" ON "tasks"("seriesId", "occurrenceKey");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_seriesId_userId_fkey" FOREIGN KEY ("seriesId", "userId") REFERENCES "recurring_series"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Rules Prisma cannot express. The database itself refuses malformed series and
-- task links, so a bug in the application cannot store them. None of these
-- depend on the database locale.
-- (In SQL a CHECK that evaluates to NULL passes, so every rule below is written so
-- that a missing value makes it FALSE, never NULL.)
ALTER TABLE "recurring_series"
  ADD CONSTRAINT "recurring_series_weekdays_range_check"
    CHECK ("weekdays" IS NOT NULL AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]),
  ADD CONSTRAINT "recurring_series_type_shape_check" CHECK (
       ("type" = 'DAILY'           AND cardinality("weekdays") = 0 AND "monthlyDay" IS NULL)
    OR ("type" = 'WEEKLY'          AND cardinality("weekdays") = 1 AND "monthlyDay" IS NULL)
    OR ("type" = 'MONTHLY'         AND cardinality("weekdays") = 0 AND "monthlyDay" IS NOT NULL AND "monthlyDay" BETWEEN 1 AND 31)
    OR ("type" = 'CUSTOM_WEEKDAYS' AND cardinality("weekdays") BETWEEN 1 AND 7 AND "monthlyDay" IS NULL)
  ),
  ADD CONSTRAINT "recurring_series_end_after_anchor_check"
    CHECK ("endDate" IS NULL OR "endDate" >= "anchorDate"),
  ADD CONSTRAINT "recurring_series_paused_until_check"
    CHECK ("pausedUntil" IS NULL OR "state" = 'PAUSED'),
  ADD CONSTRAINT "recurring_series_deadline_check" CHECK (
       ("deadlineOffsetDays" IS NULL AND "deadlineTime" IS NULL)
    OR ("deadlineOffsetDays" IS NOT NULL AND "deadlineOffsetDays" BETWEEN -3650 AND 3650)
  ),
  ADD CONSTRAINT "recurring_series_version_check"
    CHECK ("version" >= 1);

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_series_occurrence_check"
    CHECK (("seriesId" IS NULL) = ("occurrenceKey" IS NULL)),
  ADD CONSTRAINT "tasks_occurrence_key_format_check"
    CHECK ("occurrenceKey" IS NULL OR "occurrenceKey" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?$'),
  ADD CONSTRAINT "tasks_predecessor_not_self_check"
    CHECK ("predecessorId" IS NULL OR "predecessorId" <> "id");

COMMIT;
