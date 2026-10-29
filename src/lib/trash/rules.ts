// The Trash retention rule, in one place so the list, restore and cleanup always agree.
//
// A task moved to Trash at instant D is recoverable while  now < D + 30 days  and expired when
// now >= D + 30 days. 30 days is exactly 30 x 24 hours measured on the UTC timeline (not calendar
// days), so daylight-saving changes cannot shift the boundary. In database terms:
//   restorable  <=>  deletedAt >  now - 30 days   (the cutoff)
//   expired     <=>  deletedAt <= now - 30 days

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_RETENTION_MS = TRASH_DAYS * DAY_MS;

// How many expired tasks one cleanup pass removes, and how many passes one visit may run.
// Every pass removes the oldest first, so repeated visits always finish the backlog.
export const PURGE_BATCH = 200;
export const PURGE_MAX_BATCHES = 10;

// Tasks deleted at or before this instant are expired.
export const retentionCutoff = (now: Date): Date => new Date(now.getTime() - TRASH_RETENTION_MS);

// The moment a task in Trash stops being restorable (and is deleted for good).
export const purgeInstant = (deletedAt: Date): Date => new Date(deletedAt.getTime() + TRASH_RETENTION_MS);

export const isExpired = (deletedAt: Date, now: Date): boolean => now.getTime() >= purgeInstant(deletedAt).getTime();

// Whole days left, rounded up ("1 day left" until the last moment); 0 once expired.
export function daysLeft(deletedAt: Date, now: Date): number {
  const remaining = purgeInstant(deletedAt).getTime() - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / DAY_MS);
}
