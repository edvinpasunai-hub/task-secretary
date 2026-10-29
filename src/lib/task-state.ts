// Where a task is: active, archived or in Trash.
//
//   active   deletedAt = null, archivedAt = null   (the normal task list)
//   archived archivedAt set, deletedAt = null      (finished tasks kept out of the way)
//   in Trash deletedAt set                         (recoverable for 30 days)
//   tombstone purgedAt set (always also deletedAt) the scrubbed remains of a permanently deleted
//            occurrence of a series; see src/lib/trash/service.ts. Never shown anywhere.
//
// Every query that finds a task to show or change must start from ACTIVE_TASK (or, for an
// archived task that is only viewed, VIEWABLE_TASK).

export const ACTIVE_TASK = { deletedAt: null, archivedAt: null } as const;
export const VIEWABLE_TASK = { deletedAt: null } as const;
