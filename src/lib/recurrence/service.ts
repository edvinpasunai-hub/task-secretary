import "server-only";

// Server-side recurring-task operations. Every function takes a context with the
// user's id (never taken from the browser) and only touches that user's rows.
// There are no Server Actions here on purpose: the UI stage (4.3.2) wraps these
// with actions that resolve the user via requireUser().
//
// A series may switch between date-only and timed in either direction (see
// updateSeries). Instances keep the occurrence key they were created with, so a
// series can hold instances of both kinds for a while; the keys still order
// correctly ("2026-11-09" sorts as 00:00 of that day).
//
// How duplicates and races are prevented (see also the migration):
//  1. Every operation on a series runs in ONE transaction that first takes a
//     per-series advisory lock, so operations on the same series run one by one.
//  2. A task is "claimed" for completion with a conditional update, so repeated
//     or simultaneous completions of the same task do the work only once.
//  3. A successor is only created by the TAIL instance (the one with the greatest
//     occurrence), and only while the series is ACTIVE. Completing an older
//     instance (for example after Undo Complete) never creates anything.
//  4. The successor is inserted with ON CONFLICT DO NOTHING. The database itself
//     refuses a second copy of an occurrence (unique seriesId + occurrenceKey)
//     and a second successor for one instance (unique predecessorId), even if
//     steps 1-3 were bypassed.
//  5. Edits to the series row are version-checked (optimistic concurrency).

import type { Prisma, RecurringSeries } from "@/generated/prisma/client";
import type { TaskStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { isoWeekday, parseCivil } from "@/lib/recurrence/civil-date";
import { forecastOccurrences, type ForecastInput } from "@/lib/recurrence/forecast";
import { logRecurrenceError } from "@/lib/recurrence/log";
import {
  buildOccurrence,
  deadlineFor,
  deadlineOffsetFor,
  nextOccurrenceAfter,
  normalizeWeekdays,
  occursOn,
  parseOccurrenceKey,
  RECURRENCE_TIME_ZONE,
  referencePoint,
  ruleFromAnchor,
  validateRule,
  type Occurrence,
  type RuleConfig,
} from "@/lib/recurrence/rules";
import {
  AbortWith,
  fail,
  ok,
  type InstanceRef,
  type NewTaskFields,
  type RecurrenceErrorCode,
  type Result,
  type SeriesState,
  type SeriesView,
  type ServiceContext,
} from "@/lib/recurrence/types";
import {
  convertInputSchema,
  endDateSchema,
  idSchema,
  pauseUntilSchema,
  SCHEDULE_FIELDS,
  seriesPatchSchema,
  TEMPLATE_FIELDS,
  versionSchema,
  type ConvertInput,
  type SeriesPatch,
} from "@/lib/recurrence/validation";
import { dateFromDb, dateToDb, nowInTimeZone, timeFromDb, timeToDb, type LocalDate, type LocalNow, type LocalTime } from "@/lib/local-time";
import { applyDeadlineChange } from "@/lib/task-rules";
import { ACTIVE_TASK } from "@/lib/task-state";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;
// Prisma's "transaction conflict" and "foreign key violated" (a category deleted a
// moment ago): the whole operation is simply tried again from the start.
const RETRYABLE_CODES = new Set(["P2034", "P2003"]);

// Runs `fn` as ONE transaction. Expected problems thrown with abort() become a typed
// failure and roll everything back. Server Actions use this to save a task and its
// series together.
export async function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<Result<T>> {
  return runTx(fn);
}

export async function runTx<T>(fn: (tx: Tx) => Promise<T>): Promise<Result<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return ok(await prisma.$transaction(fn, TX_OPTIONS));
    } catch (error) {
      if (error instanceof AbortWith) return error.result;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (RETRYABLE_CODES.has(code) && attempt < 3) continue;
      throw error;
    }
  }
}

export const abort = (code: RecurrenceErrorCode, message: string, extra: Parameters<typeof fail>[2] = {}): never => {
  throw new AbortWith(fail(code, message, extra));
};

export const clock = (ctx: ServiceContext) => ctx.now ?? new Date();
export const localNowOf = (ctx: ServiceContext): LocalNow => nowInTimeZone(RECURRENCE_TIME_ZONE, clock(ctx));
const firstMessage = (error: { issues: Array<{ message: string }> }) => error.issues[0]?.message ?? "Please check the input.";

export function seriesToRule(series: RecurringSeries): RuleConfig {
  return {
    type: series.type,
    weekdays: series.weekdays,
    monthlyDay: series.monthlyDay,
    anchorDate: dateFromDb(series.anchorDate)!,
    plannedTime: timeFromDb(series.plannedTime),
    endDate: dateFromDb(series.endDate),
    deadlineOffsetDays: series.deadlineOffsetDays,
    deadlineTime: timeFromDb(series.deadlineTime),
  };
}

export function toSeriesView(series: RecurringSeries): SeriesView {
  return {
    id: series.id,
    type: series.type,
    weekdays: series.weekdays,
    monthlyDay: series.monthlyDay,
    anchorDate: dateFromDb(series.anchorDate)!,
    plannedTime: timeFromDb(series.plannedTime),
    title: series.title,
    description: series.description,
    importance: series.importance,
    estimatedMinutes: series.estimatedMinutes,
    categoryId: series.categoryId,
    deadlineOffsetDays: series.deadlineOffsetDays,
    deadlineTime: timeFromDb(series.deadlineTime),
    endDate: dateFromDb(series.endDate),
    state: series.state,
    pausedUntil: dateFromDb(series.pausedUntil),
    version: series.version,
  };
}

// Serializes all operations on one series for the rest of the transaction.
export async function lockSeries(tx: Tx, seriesId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${seriesId}, 0))`;
}

export const loadSeries = (tx: Tx, userId: string, seriesId: string) => tx.recurringSeries.findFirst({ where: { id: seriesId, userId } });

// The instance with the greatest scheduled occurrence. Compared byte for byte
// (COLLATE "C"), so the answer never depends on the database's locale.
export async function latestInstance(tx: Tx, seriesId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; occurrenceKey: string; status: TaskStatus; deletedAt: Date | null }>>`
    SELECT id, "occurrenceKey", status::text AS status, "deletedAt"
    FROM tasks
    WHERE "seriesId" = ${seriesId}
    ORDER BY "occurrenceKey" COLLATE "C" DESC
    LIMIT 1`;
  return rows[0] ?? null;
}

// The predecessor link of a new instance. An instance can have only one successor
// link (unique in the database); if `taskId` already has one, for example because
// a schedule edit made it the latest instance after its old successor, the new
// instance is created without a link instead of not being created at all.
async function freePredecessor(tx: Tx, taskId: string): Promise<string | null> {
  return (await tx.task.count({ where: { predecessorId: taskId } })) === 0 ? taskId : null;
}

const findSuccessor = (tx: Tx, taskId: string): Promise<InstanceRef | null> =>
  tx.task.findFirst({ where: { predecessorId: taskId }, select: { id: true, occurrenceKey: true } }) as Promise<InstanceRef | null>;

// Copies the series template into a brand-new instance (status To do, nothing
// completed, no postponements). Returns null if the database already had one.
async function createInstance(tx: Tx, series: RecurringSeries, occurrence: Occurrence, predecessorId: string | null): Promise<InstanceRef | null> {
  const deadline = deadlineFor(seriesToRule(series), occurrence.date);
  const { count } = await tx.task.createMany({
    data: [
      {
        userId: series.userId,
        seriesId: series.id,
        occurrenceKey: occurrence.key,
        predecessorId,
        title: series.title,
        description: series.description,
        importance: series.importance,
        estimatedMinutes: series.estimatedMinutes,
        categoryId: series.categoryId,
        status: "TODO",
        plannedDate: dateToDb(occurrence.date),
        plannedTime: timeToDb(occurrence.time),
        deadlineDate: dateToDb(deadline?.date ?? null),
        deadlineTime: timeToDb(deadline?.time ?? null),
        originalDeadlineDate: dateToDb(deadline?.date ?? null),
        rescheduleCount: 0,
        completedAt: null,
      },
    ],
    skipDuplicates: true, // ON CONFLICT DO NOTHING: a duplicate is refused without aborting the transaction
  });
  if (count !== 1) return null;
  return (await tx.task.findFirst({ where: { seriesId: series.id, occurrenceKey: occurrence.key }, select: { id: true, occurrenceKey: true } })) as InstanceRef;
}

// The generation of new instances is over (the end date has been reached).
async function markEnded(tx: Tx, series: RecurringSeries) {
  await tx.recurringSeries.updateMany({
    where: { id: series.id, userId: series.userId, state: { in: ["ACTIVE", "PAUSED"] } },
    data: { state: "ENDED", pausedUntil: null, version: { increment: 1 } },
  });
}

// Used after resume / reconcile / extending the end date, and when the tail is moved to
// Trash. Creates the next instance only when the TAIL instance is finished (completed, or in
// Trash, which skips that occurrence); otherwise completing the tail will create it. Starts
// after the later of the tail's occurrence and today.
export async function ensureNext(tx: Tx, series: RecurringSeries, now: LocalNow): Promise<InstanceRef | null> {
  if (series.state !== "ACTIVE") return null;
  const tail = await latestInstance(tx, series.id);
  if (tail && tail.status !== "COMPLETED" && tail.deletedAt === null) return null;
  const rule = seriesToRule(series);
  const next = nextOccurrenceAfter(rule, referencePoint(rule, tail ? parseOccurrenceKey(tail.occurrenceKey) : null, now));
  if (!next) {
    await markEnded(tx, series);
    return null;
  }
  return createInstance(tx, series, next, tail ? await freePredecessor(tx, tail.id) : null);
}

// A pause whose date has come is over: resume the series and create the nearest
// future instance if one is due. Safe to repeat and to run concurrently (the
// conditional update succeeds for exactly one caller).
async function reconcileInTx(tx: Tx, series: RecurringSeries, now: LocalNow): Promise<{ series: RecurringSeries; resumed: boolean }> {
  const pausedUntil = dateFromDb(series.pausedUntil);
  if (series.state !== "PAUSED" || pausedUntil === null || pausedUntil > now.date) return { series, resumed: false };
  const { count } = await tx.recurringSeries.updateMany({
    where: { id: series.id, userId: series.userId, state: "PAUSED", pausedUntil: { lte: dateToDb(now.date)! } },
    data: { state: "ACTIVE", pausedUntil: null, version: { increment: 1 } },
  });
  let fresh = (await loadSeries(tx, series.userId, series.id))!;
  if (count === 1) {
    await ensureNext(tx, fresh, now);
    fresh = (await loadSeries(tx, series.userId, series.id))!;
  }
  return { series: fresh, resumed: count === 1 };
}

// Inside an operation, a failed reconcile must stop the operation (its result
// depends on the series state), and be reported, not swallowed.
export async function reconcileForOperation(tx: Tx, ctx: ServiceContext, series: RecurringSeries) {
  try {
    return await reconcileInTx(tx, series, localNowOf(ctx));
  } catch (error) {
    logRecurrenceError("recurrence.reconcile_failed", { seriesId: series.id, userId: ctx.userId }, error);
    return abort("RECONCILE_FAILED", "The series could not be brought up to date. Nothing was changed; please try again.");
  }
}

// Version-checked change of the series row. Returns the updated row, or aborts
// with the reason (not found / stopped / stale version / wrong state).
export async function claimVersion(
  tx: Tx,
  ctx: ServiceContext,
  seriesId: string,
  expectedVersion: number,
  allowedStates: SeriesState[],
  data: Prisma.RecurringSeriesUpdateManyMutationInput,
): Promise<RecurringSeries> {
  const { count } = await tx.recurringSeries.updateMany({
    where: { id: seriesId, userId: ctx.userId, version: expectedVersion, state: { in: allowedStates } },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 1) return (await loadSeries(tx, ctx.userId, seriesId))!;

  const current = await loadSeries(tx, ctx.userId, seriesId);
  if (!current) return abort("NOT_FOUND", "This series was not found.");
  if (current.state === "STOPPED") return abort("SERIES_STOPPED", "Repeating was turned off for this series.");
  if (current.version !== expectedVersion) {
    return abort("CONFLICT", "This series was changed somewhere else. Please refresh and try again.", { currentVersion: current.version });
  }
  return abort("INVALID_STATE", `This is not possible while the series is ${current.state.toLowerCase()}.`);
}

// ---------------------------------------------------------------------------
// Completing a task
// ---------------------------------------------------------------------------

export type CompleteOutcome = {
  taskId: string;
  // true when the task was already completed (a repeated or simultaneous request)
  alreadyCompleted: boolean;
  successor: InstanceRef | null;
  seriesState: SeriesState | null;
};

// Completes a task and, for a recurring one, creates its successor if the rules
// say so. Idempotent. Call inside a transaction (see completeTask).
export async function completeTaskInTx(tx: Tx, ctx: ServiceContext, taskId: string): Promise<CompleteOutcome> {
  if (!idSchema.safeParse(taskId).success) return abort("NOT_FOUND", "This task was not found.");
  let task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, ...ACTIVE_TASK } });
  if (!task) return abort("NOT_FOUND", "This task was not found.");

  let series: RecurringSeries | null = null;
  if (task.seriesId) {
    await lockSeries(tx, task.seriesId);
    const loaded = await loadSeries(tx, ctx.userId, task.seriesId);
    if (loaded) series = (await reconcileForOperation(tx, ctx, loaded)).series;
    // Another request may have completed this task while we waited for the lock.
    const reloaded = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, ...ACTIVE_TASK } });
    if (!reloaded) return abort("NOT_FOUND", "This task was not found."); // moved to Trash or archived meanwhile
    task = reloaded;
  }

  const done = async (alreadyCompleted: boolean, successor: InstanceRef | null, state: SeriesState | null = series?.state ?? null): Promise<CompleteOutcome> => ({
    taskId,
    alreadyCompleted,
    successor,
    seriesState: state,
  });

  if (task.status === "COMPLETED") return done(true, await findSuccessor(tx, taskId));
  const claim = await tx.task.updateMany({
    where: { id: taskId, userId: ctx.userId, status: { not: "COMPLETED" } },
    data: { status: "COMPLETED", completedAt: clock(ctx) },
  });
  if (claim.count === 0) return done(true, await findSuccessor(tx, taskId));

  if (!series || series.state !== "ACTIVE") return done(false, null); // not recurring, paused, ended or stopped

  // Only the tail instance continues the series.
  const tail = await latestInstance(tx, series.id);
  if (!tail || tail.id !== task.id) return done(false, null);

  const rule = seriesToRule(series);
  const next = nextOccurrenceAfter(rule, referencePoint(rule, parseOccurrenceKey(task.occurrenceKey!), localNowOf(ctx)));
  if (!next) {
    await markEnded(tx, series);
    return done(false, null, "ENDED");
  }
  return done(false, await createInstance(tx, series, next, await freePredecessor(tx, task.id)));
}

export function completeTask(ctx: ServiceContext, taskId: string): Promise<Result<CompleteOutcome>> {
  return runTx((tx) => completeTaskInTx(tx, ctx, taskId));
}

// ---------------------------------------------------------------------------
// Making an ordinary task recurring / turning recurrence off
// ---------------------------------------------------------------------------

type CreatedSeries = { seriesId: string; taskId: string; version: number; successor: InstanceRef | null };

// The category of a series template must be one of the user's own.
async function assertOwnCategory(tx: Tx, userId: string, categoryId: string | null) {
  if (categoryId && (await tx.category.count({ where: { id: categoryId, userId } })) !== 1) abort("VALIDATION", "Please choose one of your categories.");
}

// The repeat rule for a task with these dates. Recurrence is anchored to the planned date.
function ruleForTask(
  task: Pick<NewTaskFields, "plannedDate" | "plannedTime" | "deadlineDate" | "deadlineTime">,
  repeat: ConvertInput,
): RuleConfig {
  if (!task.plannedDate) {
    return abort("VALIDATION", "A repeating task needs a planned date.", { issues: [{ field: "anchorDate", code: "PLANNED_DATE_REQUIRED", message: "A repeating task needs a planned date." }] });
  }
  const rule = ruleFromAnchor(repeat.type, task.plannedDate, {
    weekdays: repeat.weekdays,
    plannedTime: task.plannedTime,
    endDate: repeat.endDate ?? null,
    deadlineOffsetDays: deadlineOffsetFor(task.plannedDate, task.deadlineDate),
    deadlineTime: task.deadlineDate ? task.deadlineTime : null,
  });
  const issues = validateRule(rule);
  if (issues.length > 0) return abort("VALIDATION", issues[0].message, { issues });
  return rule;
}

async function insertSeries(tx: Tx, userId: string, rule: RuleConfig, template: Pick<NewTaskFields, "title" | "description" | "importance" | "estimatedMinutes" | "categoryId">) {
  const series = await tx.recurringSeries.create({
    data: {
      userId,
      type: rule.type,
      weekdays: rule.weekdays,
      monthlyDay: rule.monthlyDay,
      anchorDate: dateToDb(rule.anchorDate)!,
      plannedTime: timeToDb(rule.plannedTime),
      title: template.title,
      description: template.description,
      importance: template.importance,
      estimatedMinutes: template.estimatedMinutes,
      categoryId: template.categoryId,
      deadlineOffsetDays: rule.deadlineOffsetDays,
      deadlineTime: timeToDb(rule.deadlineTime),
      endDate: dateToDb(rule.endDate),
    },
  });
  await lockSeries(tx, series.id);
  return series;
}

// Creates a NEW repeating task: the series and its first instance, in one
// transaction. If anything fails, neither exists.
export async function createRecurringTask(ctx: ServiceContext, task: NewTaskFields, repeat: ConvertInput): Promise<Result<CreatedSeries>> {
  const parsed = convertInputSchema.safeParse(repeat);
  if (!parsed.success) return fail("VALIDATION", firstMessage(parsed.error));
  return runTx((tx) => createRecurringTaskInTx(tx, ctx, task, parsed.data));
}

export async function createRecurringTaskInTx(tx: Tx, ctx: ServiceContext, task: NewTaskFields, repeat: ConvertInput): Promise<CreatedSeries> {
  await assertOwnCategory(tx, ctx.userId, task.categoryId);
  const rule = ruleForTask(task, repeat);
  const series = await insertSeries(tx, ctx.userId, rule, task);
  const created = await tx.task.create({
    data: {
      userId: ctx.userId,
      seriesId: series.id,
      occurrenceKey: buildOccurrence(rule.anchorDate, rule.plannedTime).key,
      title: task.title,
      description: task.description,
      importance: task.importance,
      categoryId: task.categoryId,
      estimatedMinutes: task.estimatedMinutes,
      plannedDate: dateToDb(task.plannedDate),
      plannedTime: timeToDb(task.plannedTime),
      deadlineDate: dateToDb(task.deadlineDate),
      deadlineTime: timeToDb(task.deadlineTime),
      originalDeadlineDate: dateToDb(task.deadlineDate),
    },
  });
  return { seriesId: series.id, taskId: created.id, version: series.version, successor: null };
}

// Makes an existing ordinary task repeat. The SAME task becomes the first instance:
// id, status and history stay.
export async function convertToRecurring(ctx: ServiceContext, taskId: string, input: ConvertInput): Promise<Result<CreatedSeries>> {
  const parsed = convertInputSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", firstMessage(parsed.error));
  if (!idSchema.safeParse(taskId).success) return fail("NOT_FOUND", "This task was not found.");
  return runTx((tx) => convertInTx(tx, ctx, taskId, parsed.data));
}

export async function convertInTx(tx: Tx, ctx: ServiceContext, taskId: string, repeat: ConvertInput): Promise<CreatedSeries> {
  const task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, ...ACTIVE_TASK } });
  if (!task) return abort("NOT_FOUND", "This task was not found.");
  if (task.seriesId) return abort("ALREADY_RECURRING", "This task already repeats.");
  const fields: NewTaskFields = {
    title: task.title,
    description: task.description,
    importance: task.importance,
    categoryId: task.categoryId,
    estimatedMinutes: task.estimatedMinutes,
    plannedDate: dateFromDb(task.plannedDate),
    plannedTime: timeFromDb(task.plannedTime),
    deadlineDate: dateFromDb(task.deadlineDate),
    deadlineTime: timeFromDb(task.deadlineTime),
  };
  await assertOwnCategory(tx, ctx.userId, task.categoryId);
  const rule = ruleForTask(fields, repeat);
  const series = await insertSeries(tx, ctx.userId, rule, fields);
  await tx.task.update({
    where: { id: task.id, userId: ctx.userId },
    data: { seriesId: series.id, occurrenceKey: buildOccurrence(rule.anchorDate, rule.plannedTime).key },
  });
  const successor = task.status === "COMPLETED" ? await ensureNext(tx, series, localNowOf(ctx)) : null;
  return { seriesId: series.id, taskId: task.id, version: (await loadSeries(tx, ctx.userId, series.id))!.version, successor };
}

// "Repeat: Never". The series stops for good; the task becomes an ordinary task.
// Completed history stays linked to the stopped series; the task keeps its
// predecessor link for provenance. Nothing is deleted or completed.
export async function disableRecurrence(ctx: ServiceContext, taskId: string, expectedVersion: number): Promise<Result<{ seriesId: string; version: number }>> {
  if (!idSchema.safeParse(taskId).success) return fail("NOT_FOUND", "This task was not found.");
  if (!versionSchema.safeParse(expectedVersion).success) return fail("VALIDATION", "A version is required.");
  return runTx((tx) => disableRecurrenceInTx(tx, ctx, taskId, expectedVersion));
}

export async function disableRecurrenceInTx(tx: Tx, ctx: ServiceContext, taskId: string, expectedVersion: number): Promise<{ seriesId: string; version: number }> {
  const task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, ...ACTIVE_TASK } });
  if (!task) return abort("NOT_FOUND", "This task was not found.");
  if (!task.seriesId) return abort("NOT_RECURRING", "This task does not repeat.");
  await lockSeries(tx, task.seriesId);
  const stopped = await claimVersion(tx, ctx, task.seriesId, expectedVersion, ["ACTIVE", "PAUSED", "ENDED"], { state: "STOPPED", pausedUntil: null });
  await tx.task.update({ where: { id: task.id, userId: ctx.userId }, data: { seriesId: null, occurrenceKey: null } });
  return { seriesId: stopped.id, version: stopped.version };
}

// Stops the whole series without touching any task (the building block for
// "delete series" in Stage 4.5).
export async function stopSeries(ctx: ServiceContext, seriesId: string, expectedVersion: number): Promise<Result<SeriesView>> {
  if (!idSchema.safeParse(seriesId).success) return fail("NOT_FOUND", "This series was not found.");
  return runTx(async (tx) => {
    await lockSeries(tx, seriesId);
    return toSeriesView(await claimVersion(tx, ctx, seriesId, expectedVersion, ["ACTIVE", "PAUSED", "ENDED"], { state: "STOPPED", pausedUntil: null }));
  });
}

// ---------------------------------------------------------------------------
// Pause, resume, end date
// ---------------------------------------------------------------------------

// until = null pauses indefinitely; a date pauses until the start of that day.
export async function pauseSeries(ctx: ServiceContext, seriesId: string, expectedVersion: number, until: LocalDate | null = null): Promise<Result<SeriesView>> {
  if (!idSchema.safeParse(seriesId).success) return fail("NOT_FOUND", "This series was not found.");
  const parsed = pauseUntilSchema.safeParse(until);
  if (!parsed.success) return fail("VALIDATION", firstMessage(parsed.error));
  if (until !== null && until <= localNowOf(ctx).date) return fail("VALIDATION", "The pause must end on a later date.");

  return runTx(async (tx) => {
    await lockSeries(tx, seriesId);
    const loaded = await loadSeries(tx, ctx.userId, seriesId);
    if (!loaded) return abort("NOT_FOUND", "This series was not found.");
    await reconcileForOperation(tx, ctx, loaded);
    return toSeriesView(await claimVersion(tx, ctx, seriesId, expectedVersion, ["ACTIVE", "PAUSED"], { state: "PAUSED", pausedUntil: dateToDb(until) }));
  });
}

// Resume now. Already active = nothing to do (so a retried request is harmless).
// Never creates a backlog: the next instance is the nearest FUTURE occurrence.
export async function resumeSeries(ctx: ServiceContext, seriesId: string, expectedVersion: number): Promise<Result<{ series: SeriesView; created: InstanceRef | null }>> {
  if (!idSchema.safeParse(seriesId).success) return fail("NOT_FOUND", "This series was not found.");
  return runTx(async (tx) => {
    await lockSeries(tx, seriesId);
    const loaded = await loadSeries(tx, ctx.userId, seriesId);
    if (!loaded) return abort("NOT_FOUND", "This series was not found.");
    if (loaded.state === "ACTIVE") return { series: toSeriesView(loaded), created: null };
    const resumed = await claimVersion(tx, ctx, seriesId, expectedVersion, ["PAUSED"], { state: "ACTIVE", pausedUntil: null });
    const created = await ensureNext(tx, resumed, localNowOf(ctx));
    return { series: toSeriesView((await loadSeries(tx, ctx.userId, seriesId))!), created };
  });
}

// Sets, shortens or removes the (inclusive) end date. Extending an ended series
// brings it back when a further occurrence becomes possible.
export async function setSeriesEndDate(ctx: ServiceContext, seriesId: string, expectedVersion: number, endDate: LocalDate | null): Promise<Result<{ series: SeriesView; created: InstanceRef | null }>> {
  if (!idSchema.safeParse(seriesId).success) return fail("NOT_FOUND", "This series was not found.");
  const parsed = endDateSchema.safeParse(endDate);
  if (!parsed.success) return fail("VALIDATION", firstMessage(parsed.error));

  return runTx(async (tx) => {
    await lockSeries(tx, seriesId);
    const loaded = await loadSeries(tx, ctx.userId, seriesId);
    if (!loaded) return abort("NOT_FOUND", "This series was not found.");
    const rule = { ...seriesToRule(loaded), endDate };
    const issues = validateRule(rule);
    if (issues.length > 0) return abort("VALIDATION", issues[0].message, { issues });

    // An ended series continues only if the new end date leaves room for a next occurrence.
    let state: SeriesState = loaded.state;
    if (loaded.state === "ENDED") {
      const tail = await latestInstance(tx, seriesId);
      const reference = referencePoint(rule, tail ? parseOccurrenceKey(tail.occurrenceKey) : null, localNowOf(ctx));
      state = nextOccurrenceAfter(rule, reference) ? "ACTIVE" : "ENDED";
    }
    const updated = await claimVersion(tx, ctx, seriesId, expectedVersion, ["ACTIVE", "PAUSED", "ENDED"], { endDate: dateToDb(endDate), state });
    const created = loaded.state === "ENDED" && state === "ACTIVE" ? await ensureNext(tx, updated, localNowOf(ctx)) : null;
    return { series: toSeriesView((await loadSeries(tx, ctx.userId, seriesId))!), created };
  });
}

// ---------------------------------------------------------------------------
// Expired pauses (no background job: checked when the user uses the app)
// ---------------------------------------------------------------------------

export type ReconcileReport = { reconciled: number; failed: Array<{ seriesId: string; code: string }>; skippedByBackoff: number };

// After a failure, the same series is not retried for this long (per server
// process; only an optimisation, the database stays the source of truth).
export const RECONCILE_BACKOFF_MS = 60_000;
const retryNotBefore = new Map<string, number>();
export const resetReconcileBackoff = () => retryNotBefore.clear();

// Cheap when nothing is due: one indexed read, no writes. Each series is its own
// transaction, so one failure neither blocks the others nor leaves a half-done
// change; the failure is logged and retried on a later call.
export async function reconcileExpiredPauses(ctx: ServiceContext): Promise<ReconcileReport> {
  const report: ReconcileReport = { reconciled: 0, failed: [], skippedByBackoff: 0 };
  const now = clock(ctx);
  const local = localNowOf(ctx);
  const due = await prisma.recurringSeries.findMany({
    where: { userId: ctx.userId, state: "PAUSED", pausedUntil: { lte: dateToDb(local.date)! } },
    select: { id: true },
  });

  for (const { id } of due) {
    if ((retryNotBefore.get(id) ?? 0) > now.getTime()) {
      report.skippedByBackoff++;
      continue;
    }
    try {
      const result = await runTx(async (tx) => {
        await lockSeries(tx, id);
        const series = await loadSeries(tx, ctx.userId, id);
        return series ? (await reconcileInTx(tx, series, local)).resumed : false;
      });
      if (result.ok && result.value) report.reconciled++;
      retryNotBefore.delete(id);
    } catch (error) {
      logRecurrenceError("recurrence.reconcile_failed", { seriesId: id, userId: ctx.userId }, error);
      retryNotBefore.set(id, now.getTime() + RECONCILE_BACKOFF_MS);
      report.failed.push({ seriesId: id, code: "RECONCILE_FAILED" });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// "This and future tasks"
// ---------------------------------------------------------------------------

// The first scheduled occurrence on `date`, or the nearest one after it.
function firstOccurrenceOnOrAfter(rule: RuleConfig, date: LocalDate): Occurrence | null {
  const probe = { ...rule, anchorDate: date };
  if (occursOn(probe, date) && (rule.endDate === null || date <= rule.endDate)) return buildOccurrence(date, rule.plannedTime);
  return nextOccurrenceAfter(probe, { date, time: rule.plannedTime === null ? null : "23:59" });
}

// Changes the series template, schedule and/or end date.
// - Template fields (title, description, importance, duration, category) are copied
//   to every UNFINISHED instance; completed history is never touched.
// - Schedule fields (type, weekdays, monthly day, time of day, deadline rule) need
//   `fromInstanceId`, the instance being edited: only that instance is
//   recalculated (left alone if its date was postponed by hand); other unfinished
//   instances keep their dates and later instances follow the new rule.
// - The time of day can be added, changed or removed: a series switches between
//   date-only and timed in either direction. Existing instances keep their old
//   occurrence keys; new ones use the new kind.
// - endDate (inclusive) can be set, shortened, extended or removed, in the same
//   version-checked step. Extending an ended series brings it back.
export async function updateSeries(
  ctx: ServiceContext,
  seriesId: string,
  expectedVersion: number,
  patch: SeriesPatch,
  options: { fromInstanceId?: string } = {},
): Promise<Result<SeriesView>> {
  if (!idSchema.safeParse(seriesId).success) return fail("NOT_FOUND", "This series was not found.");
  const parsed = seriesPatchSchema.safeParse(patch);
  if (!parsed.success) return fail("VALIDATION", firstMessage(parsed.error));
  if (SCHEDULE_FIELDS.some((field) => parsed.data[field] !== undefined) && !options.fromInstanceId) {
    return fail("VALIDATION", "Changing the schedule needs the task you are editing.");
  }
  if (options.fromInstanceId && !idSchema.safeParse(options.fromInstanceId).success) return fail("NOT_FOUND", "This task was not found.");

  return runTx(async (tx) => {
    await lockSeries(tx, seriesId);
    return updateSeriesInTx(tx, ctx, seriesId, expectedVersion, parsed.data, options);
  });
}

type ParsedPatch = ReturnType<typeof seriesPatchSchema.parse>;

// The body of updateSeries. The caller holds the series lock and has validated `data`.
async function updateSeriesInTx(tx: Tx, ctx: ServiceContext, seriesId: string, expectedVersion: number, data: ParsedPatch, options: { fromInstanceId?: string }): Promise<SeriesView> {
  const has = (field: keyof ParsedPatch) => field in data && data[field] !== undefined;
  const touchesSchedule = SCHEDULE_FIELDS.some(has);
  const touchesTemplate = TEMPLATE_FIELDS.some(has);
  const touchesEnd = has("endDate");

  const loaded = await loadSeries(tx, ctx.userId, seriesId);
  if (!loaded) return abort("NOT_FOUND", "This series was not found.");
  if (loaded.state === "STOPPED") return abort("SERIES_STOPPED", "Repeating was turned off for this series.");
  const series = (await reconcileForOperation(tx, ctx, loaded)).series;
  if (series.version !== expectedVersion) {
    return abort("CONFLICT", "This series was changed somewhere else. Please refresh and try again.", { currentVersion: series.version });
  }
  if (has("categoryId") && data.categoryId) await assertOwnCategory(tx, ctx.userId, data.categoryId);

  const seriesData: Prisma.RecurringSeriesUpdateManyMutationInput = {};
  for (const field of ["title", "description", "importance", "estimatedMinutes"] as const) if (has(field)) Object.assign(seriesData, { [field]: data[field] });

  let rule: RuleConfig = seriesToRule(series);
  let instanceUpdate: Prisma.TaskUncheckedUpdateInput | null = null;

  // ---- schedule change: recalculate the edited instance only ----
  if (touchesSchedule) {
    const instance = await tx.task.findFirst({ where: { id: options.fromInstanceId, userId: ctx.userId, seriesId } });
    if (!instance) return abort("NOT_FOUND", "This task was not found.");
    if (instance.status === "COMPLETED") return abort("VALIDATION", "Finished tasks cannot be used to change the schedule.");
    const occurrence = parseOccurrenceKey(instance.occurrenceKey!);

    const type = data.type ?? series.type;
    const weekdays =
      type === "DAILY" || type === "MONTHLY"
        ? []
        : type === "WEEKLY"
          ? (data.weekdays ?? (series.type === "WEEKLY" ? series.weekdays : [isoWeekday(occurrence.date)]))
          : normalizeWeekdays(data.weekdays ?? series.weekdays);
    const merged: RuleConfig = {
      ...rule,
      type,
      weekdays,
      monthlyDay: type === "MONTHLY" ? (data.monthlyDay ?? (series.type === "MONTHLY" ? series.monthlyDay : parseCivil(occurrence.date).day)) : null,
      plannedTime: has("plannedTime") ? data.plannedTime! : timeFromDb(series.plannedTime),
      deadlineOffsetDays: "deadlineOffsetDays" in data ? (data.deadlineOffsetDays ?? null) : series.deadlineOffsetDays,
      deadlineTime: "deadlineTime" in data ? (data.deadlineTime ?? null) : timeFromDb(series.deadlineTime),
      endDate: touchesEnd ? (data.endDate ?? null) : dateFromDb(series.endDate),
      anchorDate: occurrence.date,
    };
    const target = firstOccurrenceOnOrAfter(merged, occurrence.date);
    if (!target) return abort("VALIDATION", "No occurrence of this schedule falls on or before the end date.");
    rule = { ...merged, anchorDate: target.date };
    const issues = validateRule(rule);
    if (issues.length > 0) return abort("VALIDATION", issues[0].message, { issues });

    const manuallyMoved = dateFromDb(instance.plannedDate) !== occurrence.date || timeFromDb(instance.plannedTime) !== occurrence.time;
    if (!manuallyMoved) {
      if (target.key !== occurrence.key && (await tx.task.count({ where: { seriesId, occurrenceKey: target.key } })) > 0) {
        return abort("OCCURRENCE_CONFLICT", "Another task of this series already has that date.");
      }
      const deadline = deadlineFor(rule, target.date);
      const change = applyDeadlineChange(
        { deadlineDate: dateFromDb(instance.deadlineDate), originalDeadlineDate: dateFromDb(instance.originalDeadlineDate), rescheduleCount: instance.rescheduleCount },
        deadline?.date ?? null,
      );
      instanceUpdate = {
        occurrenceKey: target.key,
        plannedDate: dateToDb(target.date),
        plannedTime: timeToDb(target.time),
        deadlineDate: dateToDb(deadline?.date ?? null),
        deadlineTime: timeToDb(deadline?.time ?? null),
        originalDeadlineDate: dateToDb(change.originalDeadlineDate),
        rescheduleCount: change.rescheduleCount,
      };
    }
    Object.assign(seriesData, {
      type: rule.type,
      weekdays: rule.weekdays,
      monthlyDay: rule.monthlyDay,
      anchorDate: dateToDb(rule.anchorDate),
      plannedTime: timeToDb(rule.plannedTime),
      deadlineOffsetDays: rule.deadlineOffsetDays,
      deadlineTime: timeToDb(rule.deadlineTime),
    });
  } else if (touchesEnd) {
    rule = { ...rule, endDate: data.endDate ?? null };
    const issues = validateRule(rule);
    if (issues.length > 0) return abort("VALIDATION", issues[0].message, { issues });
  }

  // ---- end date ----
  let reviveEnded = false;
  if (touchesEnd) {
    seriesData.endDate = dateToDb(rule.endDate);
    if (series.state === "ENDED") {
      // An ended series continues only if the new end date leaves room for a next occurrence.
      const tail = await latestInstance(tx, seriesId);
      const reference = referencePoint(rule, tail ? parseOccurrenceKey(tail.occurrenceKey) : null, localNowOf(ctx));
      if (nextOccurrenceAfter(rule, reference)) {
        seriesData.state = "ACTIVE";
        reviveEnded = true;
      }
    }
  }

  // ---- apply (version-checked in the same transaction) ----
  const updated = await claimVersion(tx, ctx, seriesId, expectedVersion, ["ACTIVE", "PAUSED", "ENDED"], seriesData);
  if (has("categoryId")) await tx.recurringSeries.update({ where: { id: seriesId }, data: { categoryId: data.categoryId ?? null } });

  if (touchesTemplate) {
    const templateData: Prisma.TaskUncheckedUpdateManyInput = {};
    for (const field of TEMPLATE_FIELDS) if (has(field)) Object.assign(templateData, { [field]: data[field] });
    await tx.task.updateMany({ where: { seriesId, userId: ctx.userId, status: { not: "COMPLETED" } }, data: templateData });
  }
  if (instanceUpdate) await tx.task.update({ where: { id: options.fromInstanceId, userId: ctx.userId }, data: instanceUpdate });
  if (reviveEnded) await ensureNext(tx, updated, localNowOf(ctx));
  return toSeriesView((await loadSeries(tx, ctx.userId, updated.id))!);
}

// The dates the edit form shows for ONE task.
export type InstanceDates = { plannedDate: LocalDate; plannedTime: LocalTime | null; deadlineDate: LocalDate | null; deadlineTime: LocalTime | null };

// "This and future tasks" from the edit form of one task, in a single transaction:
// the series change (template, repeat rule, end date) and this task's own dates.
// The version check covers the whole save; a stale form changes nothing.
// Moving this task's planned date is a postponement of this task only: the series
// schedule is unaffected.
export async function updateTaskAndSeriesInTx(
  tx: Tx,
  ctx: ServiceContext,
  taskId: string,
  expectedVersion: number,
  patch: SeriesPatch,
  dates: InstanceDates | null,
): Promise<SeriesView> {
  const parsed = seriesPatchSchema.safeParse(patch);
  if (!parsed.success) return abort("VALIDATION", firstMessage(parsed.error));
  if (!idSchema.safeParse(taskId).success) return abort("NOT_FOUND", "This task was not found.");
  const task = await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, ...ACTIVE_TASK } });
  if (!task) return abort("NOT_FOUND", "This task was not found.");
  if (!task.seriesId) return abort("NOT_RECURRING", "This task does not repeat.");
  const seriesId = task.seriesId;

  await lockSeries(tx, seriesId);
  const patchIsEmpty = Object.values(parsed.data).every((value) => value === undefined);
  let view: SeriesView;
  if (patchIsEmpty) {
    const current = await loadSeries(tx, ctx.userId, seriesId);
    if (!current) return abort("NOT_FOUND", "This series was not found.");
    if (current.state === "STOPPED") return abort("SERIES_STOPPED", "Repeating was turned off for this series.");
    const series = (await reconcileForOperation(tx, ctx, current)).series;
    if (series.version !== expectedVersion) {
      return abort("CONFLICT", "This series was changed somewhere else. Please refresh and try again.", { currentVersion: series.version });
    }
    view = toSeriesView(series);
  } else {
    view = await updateSeriesInTx(tx, ctx, seriesId, expectedVersion, parsed.data, { fromInstanceId: taskId });
  }

  if (dates) {
    const current = (await tx.task.findFirst({ where: { id: taskId, userId: ctx.userId, ...ACTIVE_TASK } })) ?? abort("NOT_FOUND", "This task was not found.");
    const change = applyDeadlineChange(
      { deadlineDate: dateFromDb(current.deadlineDate), originalDeadlineDate: dateFromDb(current.originalDeadlineDate), rescheduleCount: current.rescheduleCount },
      dates.deadlineDate,
    );
    await tx.task.update({
      where: { id: taskId, userId: ctx.userId },
      data: {
        plannedDate: dateToDb(dates.plannedDate),
        plannedTime: timeToDb(dates.plannedTime),
        deadlineDate: dateToDb(dates.deadlineDate),
        deadlineTime: timeToDb(dates.deadlineTime),
        originalDeadlineDate: dateToDb(change.originalDeadlineDate),
        rescheduleCount: change.rescheduleCount,
      },
    });
  }
  return view;
}

export async function updateTaskAndSeries(ctx: ServiceContext, taskId: string, expectedVersion: number, patch: SeriesPatch, dates: InstanceDates | null): Promise<Result<SeriesView>> {
  return runTx((tx) => updateTaskAndSeriesInTx(tx, ctx, taskId, expectedVersion, patch, dates));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getSeries(ctx: ServiceContext, seriesId: string): Promise<SeriesView | null> {
  if (!idSchema.safeParse(seriesId).success) return null;
  const series = await prisma.recurringSeries.findFirst({ where: { id: seriesId, userId: ctx.userId } });
  return series ? toSeriesView(series) : null;
}

// Future occurrences for a calendar: calculated only, nothing is created.
export async function getSeriesForecast(
  ctx: ServiceContext,
  seriesId: string,
  options: { limit?: number; until?: LocalDate | null } = {},
): Promise<Occurrence[] | null> {
  if (!idSchema.safeParse(seriesId).success) return null;
  const series = await prisma.recurringSeries.findFirst({ where: { id: seriesId, userId: ctx.userId } });
  if (!series) return null;
  const now = localNowOf(ctx);
  const keys = (await prisma.task.findMany({ where: { seriesId, userId: ctx.userId }, select: { occurrenceKey: true } })).map((t) => t.occurrenceKey!);
  const pausedUntil = dateFromDb(series.pausedUntil);
  // A pause whose date has come no longer holds the series back.
  const expired = series.state === "PAUSED" && pausedUntil !== null && pausedUntil <= now.date;
  const input: ForecastInput = {
    rule: seriesToRule(series),
    state: expired ? "ACTIVE" : series.state,
    pausedUntil: expired ? null : pausedUntil,
    materializedKeys: keys,
    now,
    limit: options.limit,
    until: options.until ?? null,
  };
  return forecastOccurrences(input);
}

