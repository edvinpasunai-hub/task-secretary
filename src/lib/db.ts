import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { schemaKey } from "@/lib/prisma-schema-key";

// Reuse one Prisma client per server process. In development, Next.js reloads
// modules on every change, so the client is kept on globalThis to avoid
// opening a new pool of database connections each time.
//
// The kept client is only reused while it was made from the same data model as the
// generated client now on disk. After a schema change and `prisma generate`, a long-running
// dev server would otherwise keep the old client, which does not know the new columns.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaSchemaKey?: string };

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

const currentKey = schemaKey(Prisma as unknown as Record<string, unknown>);
const reusable = globalForPrisma.prisma !== undefined && globalForPrisma.prismaSchemaKey === currentKey;

if (globalForPrisma.prisma && !reusable) {
  // Close the outdated client's connections in the background; failures do not matter.
  void globalForPrisma.prisma.$disconnect().catch(() => undefined);
}

export const prisma = reusable ? globalForPrisma.prisma! : createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaSchemaKey = currentKey;
}
