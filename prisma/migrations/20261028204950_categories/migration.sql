-- CreateEnum
CREATE TYPE "CategoryColor" AS ENUM ('RED', 'AMBER', 'LIME', 'TEAL', 'SKY', 'INDIGO', 'PURPLE', 'PINK');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "color" "CategoryColor" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_userId_normalizedName_key" ON "categories"("userId", "normalizedName");

-- CreateIndex
CREATE INDEX "tasks_categoryId_idx" ON "tasks"("categoryId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Rules Prisma cannot express: the database itself refuses names that are not
-- trimmed, are empty or too long, or whose lower-case copy does not match.
ALTER TABLE "categories" ADD CONSTRAINT "categories_name_valid_check"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 50);
ALTER TABLE "categories" ADD CONSTRAINT "categories_normalizedName_check"
  CHECK ("normalizedName" = lower("name"));
