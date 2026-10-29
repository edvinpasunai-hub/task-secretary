// A short text that changes whenever the generated Prisma client's data model changes
// (a model or column added or removed). Used to notice that a Prisma client kept in memory
// by the development server is older than the one `prisma generate` just wrote.
//
// Why it matters: an old client does not know a new column, so it returns `undefined` for it.
// For the reminders' `readAt` that meant "not null" → every unread reminder was shown as read.

export function schemaKey(prismaNamespace: Record<string, unknown>): string {
  const parts = Object.entries(prismaNamespace)
    .filter(([name]) => name === "ModelName" || name.endsWith("ScalarFieldEnum"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${Object.keys((value ?? {}) as object).join(",")}`);
  return parts.join("|");
}
