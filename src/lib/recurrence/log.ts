// One place for recurrence error logging. The project has no logger yet, so this
// writes a single structured line to the server console; swapping in a real
// logger later only means changing this file.
//
// Privacy: only identifiers and the kind of error are logged. Never titles,
// descriptions or database messages (Prisma messages can contain the values
// that were being saved).

export type LogContext = { seriesId?: string; userId?: string; taskId?: string };

function errorKind(error: unknown): { name: string; code: string | null } {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error && typeof error.name === "string" ? error.name : "Error";
    const code = "code" in error && typeof error.code === "string" ? error.code : null;
    return { name, code };
  }
  return { name: "UnknownError", code: null };
}

export function logRecurrenceError(event: string, context: LogContext, error: unknown): void {
  console.error(JSON.stringify({ event, ...context, error: errorKind(error), at: new Date().toISOString() }));
}
