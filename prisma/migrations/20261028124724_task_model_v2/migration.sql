-- CreateEnum
CREATE TYPE "Importance" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- AlterEnum
BEGIN;
CREATE TYPE "TaskStatus_new" AS ENUM ('TODO', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED');
ALTER TABLE "public"."tasks" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "tasks" ALTER COLUMN "status" TYPE "TaskStatus_new" USING ("status"::text::"TaskStatus_new");
ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
DROP TYPE "public"."TaskStatus_old";
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'TODO';
COMMIT;

-- DropIndex
DROP INDEX "tasks_userId_status_dueDate_idx";

-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "dueDate",
DROP COLUMN "originalDueDate",
DROP COLUMN "priority",
ADD COLUMN     "deadlineDate" DATE,
ADD COLUMN     "deadlineTime" TIME(0),
ADD COLUMN     "estimatedMinutes" INTEGER,
ADD COLUMN     "importance" "Importance" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "originalDeadlineDate" DATE,
ADD COLUMN     "plannedDate" DATE,
ADD COLUMN     "plannedTime" TIME(0);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'Europe/Tallinn';

-- DropEnum
DROP TYPE "Priority";

-- CreateIndex
CREATE INDEX "tasks_userId_status_deadlineDate_idx" ON "tasks"("userId", "status", "deadlineDate");

